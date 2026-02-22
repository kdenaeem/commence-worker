import "dotenv/config";
import { discoveryFlowTask } from "./trigger/discovery-flow";

// Entry point - registers tasks with Trigger.dev
console.log("Worker initialized with tasks:", {
    discoveryFlow: discoveryFlowTask.id,
});
