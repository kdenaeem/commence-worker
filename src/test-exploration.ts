import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

import { runDetailPhase } from "../utils/scraping/detail-phase";

async function test() {
    const result = await runDetailPhase({
        url: "https://hsbcearlycareers.groupgti.com/relationship-management---corporate-and-institutional-banking---graduate---uk-london/524/viewdetails",
        title: "Relationship Management",
        action: "NEW_ROLE",
        firmId: "00000000-0000-0000-0000-000000000000",
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