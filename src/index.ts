import "dotenv/config";
import { discoveryFlow } from "./trigger/discovery";

// Entry point - registers tasks with Trigger.dev
console.log("Worker initialized with tasks:", {
    discoveryFlow: discoveryFlow.id,
});
