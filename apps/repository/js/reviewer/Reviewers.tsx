import {Reviewer} from "./Reviewer";
import {InjectedComponent, ReactInjector} from "../../../../web/js/ui/util/ReactInjector";
import * as React from "react";
import {ReviewerTasks} from "./ReviewerTasks";
import {Callback, NULL_FUNCTION} from "polar-shared/src/util/Functions";
import {SpacedRep, SpacedReps} from "polar-firebase/src/firebase/om/SpacedReps";
import {LightModal} from "../../../../web/js/ui/LightModal";
import {
    Rating,
    RepetitionMode,
    StageCountsCalculator,
    TaskRep
} from "polar-spaced-repetition-api/src/scheduler/S2Plus/S2Plus";
import {
    CalculatedTaskReps,
    TasksCalculator
} from "polar-spaced-repetition/src/spaced_repetition/scheduler/S2Plus/TasksCalculator";
import {Logger} from "polar-shared/src/logger/Logger";
import {Firebase} from "../../../../web/js/firebase/Firebase";
import {Dictionaries} from "polar-shared/src/util/Dictionaries";
import {Latch} from "polar-shared/src/util/Latch";
import {PreviewWarnings} from "./PreviewWarnings";
import {PersistentPrefs} from "../../../../web/js/util/prefs/Prefs";
import {DatastoreCapabilities} from "../../../../web/js/datastore/Datastore";
import {ConfirmProps, Dialogs} from "../../../../web/js/ui/dialogs/Dialogs";
import {Preconditions} from "polar-shared/src/Preconditions";
import {SpacedRepStat, SpacedRepStats} from "polar-firebase/src/firebase/om/SpacedRepStats";
import {FirestoreCollections} from "./FirestoreCollections";
import {RendererAnalytics} from "../../../../web/js/ga/RendererAnalytics";
import {IDocAnnotation} from "../../../../web/js/annotation_sidebar/DocAnnotation";
import {ReadingTaskAction} from "./cards/ReadingTaskAction";
import {Confirm} from "../../../../web/js/ui/dialogs/Confirm";

const log = Logger.create();

export class Reviewers {

    public static start(datastoreCapabilities: DatastoreCapabilities,
                        prefs: PersistentPrefs,
                        repoDocAnnotations: ReadonlyArray<IDocAnnotation>,
                        mode: RepetitionMode,
                        limit: number = 10) {

        this.createAndInject(datastoreCapabilities, prefs, repoDocAnnotations, mode, limit)
            .catch(err => console.error("Unable to start review: ", err));

    }


    private static async notifyPreview(prefs: PersistentPrefs) {
        const latch = new Latch();

        await PreviewWarnings.doWarning(prefs, () => latch.resolve(true));

        await latch.get();
    }

    private static createWebRequiredError() {

        const props: ConfirmProps = {
            title: 'Cloud sync required (please login)',
            subtitle: 'Cloud sync is required to review annotations.  Please login to review flashcards and reading.',
            type: 'danger',
            onConfirm: NULL_FUNCTION,
            noCancel: true
        };

        return <Confirm {...props}/>;

    }

    private static createNoTasksMessage() {

        const props: ConfirmProps = {
            title: 'No tasks to complete',
            subtitle: "Awesome.  Looks like you're all caught up and have no tasks to complete.",
            type: 'success',
            onConfirm: NULL_FUNCTION,
            noCancel: true
        };

        return <Confirm {...props}/>;

    }

    public static async createAndInject(datastoreCapabilities: DatastoreCapabilities,
                                        prefs: PersistentPrefs,
                                        repoDocAnnotations: ReadonlyArray<IDocAnnotation>,
                                        mode: RepetitionMode,
                                        limit: number = 10) {

        let injected: InjectedComponent | undefined;

        const doClose = () => {
            injected!.destroy();
        };

        const reviewer = await this.create(datastoreCapabilities, prefs, repoDocAnnotations, mode, doClose, limit);

        if (reviewer) {

            injected = ReactInjector.inject(reviewer);
        }

    }


    public static async create(datastoreCapabilities: DatastoreCapabilities,
                               prefs: PersistentPrefs,
                               repoDocAnnotations: ReadonlyArray<IDocAnnotation>,
                               mode: RepetitionMode,
                               doClose: Callback = NULL_FUNCTION,
                               limit: number = 10): Promise<JSX.Element> {

        Preconditions.assertPresent(mode, 'mode');

        const uid = await Firebase.currentUserID();

        if (! datastoreCapabilities.networkLayers.has('web')) {
            return this.createWebRequiredError();
        }

        if (! uid) {
            throw new Error("Not authenticated");
        }

        await FirestoreCollections.configure();

        await this.notifyPreview(prefs);

        const calculateTaskReps = async (): Promise<CalculatedTaskReps<any>> => {
            switch (mode) {
                case "flashcard":
                    return await ReviewerTasks.createFlashcardTasks(repoDocAnnotations, limit);
                case "reading":
                    return await ReviewerTasks.createReadingTasks(repoDocAnnotations, limit);

            }
        };


        const calculatedTaskReps = await calculateTaskReps();
        const {taskReps} = calculatedTaskReps;

        const doWriteQueueStageCounts = async () => {

            const spacedRepStats: SpacedRepStat = {
                type: 'queue',
                mode,
                ...calculatedTaskReps.stageCounts
            };

            await SpacedRepStats.write(uid, spacedRepStats);

        };

        await doWriteQueueStageCounts();

        if (taskReps.length === 0) {
            return this.createNoTasksMessage();
        }

        console.log("Found N tasks: " + taskReps.length);

        const completedStageCounts = StageCountsCalculator.createMutable();

        const incrCompletedStageCounts = (taskRep: TaskRep<any>) => {

            switch (taskRep.stage) {
                case "new":
                    ++completedStageCounts.nrNew;
                    break;
                case "learning":
                    ++completedStageCounts.nrLearning;
                    break;
                case "review":
                    ++completedStageCounts.nrReview;
                    break;
                case "lapsed":
                    ++completedStageCounts.nrLapsed;
                    break;
            }

        };

        const doWriteCompletedStageCounts = async () => {

            const spacedRepStats: SpacedRepStat = {
                type: 'completed',
                mode,
                ...completedStageCounts
            };

            await SpacedRepStats.write(uid, spacedRepStats);

            console.log("Wrote completed state counts");

        };


        const onFinished = () => {

            console.log("Got finished...");

            doWriteCompletedStageCounts()
                .catch(err => log.error("Unable to write completed stage counts: ", err));

            doClose();

        };

        const onSuspended = (taskRep: TaskRep<ReadingTaskAction>) => {

            const convertedSpacedRep = SpacedReps.convertFromTaskRep(uid, taskRep);
            const spacedRep: SpacedRep = {
                ...convertedSpacedRep,
                suspended: true
            };

            SpacedReps.set(taskRep.id, spacedRep)
                .catch(err => log.error("Could not save state: ", err));

        };

        const onRating = (taskRep: TaskRep<any>, rating: Rating) => {

            console.log("Saving rating... ");

            const next = TasksCalculator.computeNextSpacedRep(taskRep, rating);

            const spacedRep: SpacedRep = Dictionaries.onlyDefinedProperties({uid, ...next});

            incrCompletedStageCounts(taskRep);

            SpacedReps.set(next.id, spacedRep)
                .then(() => console.log("Saving rating... done", JSON.stringify(spacedRep, null, '  ')))
                .catch(err => log.error("Could not save state: ", err));

        };

        // emit stats that the reviewer was run...
        RendererAnalytics.event({category: 'reviewer', action: 'created-' + mode});

        return (
            <LightModal>
                <Reviewer taskReps={taskReps}
                          onRating={onRating}
                          onSuspended={onSuspended}
                          onFinished={onFinished}/>
            </LightModal>
        );

    }


}
