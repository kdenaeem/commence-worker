import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

import { runDetailPhase } from "../utils/scraping/detail-phase";

async function test() {
    const result = await runDetailPhase({
        url: "https://ekbq.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/jobs?iis=Trackr&keyword=%22graduate+programme%22&mode=job-location&sType=Trackr",
        title: "Relationship Management",
        action: "NEW_ROLE",
        firmId: "34b4417e-71f9-4b69-a056-e1db5115653a",
        firmName: "HSBC",
        firmSlug: "hsbc",
        scrapeUrlId: "manual-test",
        expectedProgrammes: [],
        existingProgrammes: [],
        allRolesInScan: [
            { title: "Relationship Management", url: "https://hsbcearlycareers.groupgti.com/relationship-management---corporate-and-institutional-banking---graduate---uk-london/524/viewdetails" }
        ],
    });

    console.log("Result:", JSON.stringify(result, null, 2));
}

test().catch(console.error);