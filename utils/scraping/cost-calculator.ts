/**
 * Pricing for GPT-4o (as of Dec 2024)
 * Source: https://openai.com/api/pricing/
 */
const GPT4O_INPUT_COST_PER_MILLION = 2.50;
const GPT4O_OUTPUT_COST_PER_MILLION = 10.00;

/**
 * Pricing for GPT-4o-mini
 */
const GPT4O_MINI_INPUT_COST_PER_MILLION = 0.15;
const GPT4O_MINI_OUTPUT_COST_PER_MILLION = 0.60;

/**
 * Pricing for GPT-5 mini
 * Optimized for reasoning/chat tasks with 400k context
 */
const GPT5_MINI_INPUT_COST_PER_MILLION = 0.25;
const GPT5_MINI_OUTPUT_COST_PER_MILLION = 2.00;

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface CostBreakdown {
    inputCost: number;
    outputCost: number;
    totalCost: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
}

export type ExtractionModel = 'gpt-4o-mini' | 'gpt-5-mini';
export type ClassificationModel = 'gpt-4o-mini';
export type LLMModel = ExtractionModel | ClassificationModel;

/**
 * Calculates the cost of an API call based on token usage.
 * @param usage Token usage from the AI SDK
 * @param model Model used
 * @returns Cost breakdown in USD
 */
export function calculateCost(
    usage: TokenUsage,
    model: LLMModel = 'gpt-4o-mini'
): CostBreakdown {
    let inputCostPerMillion: number;
    let outputCostPerMillion: number;

    switch (model) {
        case 'gpt-4o':
            inputCostPerMillion = GPT4O_INPUT_COST_PER_MILLION;
            outputCostPerMillion = GPT4O_OUTPUT_COST_PER_MILLION;
            break;
        case 'gpt-4o-mini':
            inputCostPerMillion = GPT4O_MINI_INPUT_COST_PER_MILLION;
            outputCostPerMillion = GPT4O_MINI_OUTPUT_COST_PER_MILLION;
            break;
        default:
            inputCostPerMillion = GPT5_MINI_INPUT_COST_PER_MILLION;
            outputCostPerMillion = GPT5_MINI_OUTPUT_COST_PER_MILLION;
    }

    const inputCost = (usage.promptTokens / 1_000_000) * inputCostPerMillion;
    const outputCost = (usage.completionTokens / 1_000_000) * outputCostPerMillion;
    const totalCost = inputCost + outputCost;

    return {
        inputCost,
        outputCost,
        totalCost,
        totalTokens: usage.totalTokens,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
    };
}

/**
 * Accumulates usage across multiple API calls.
 */
export class UsageTracker {
    private promptTokens = 0;
    private completionTokens = 0;
    private totalTokens = 0;

    add(usage: TokenUsage): void {
        this.promptTokens += usage.promptTokens;
        this.completionTokens += usage.completionTokens;
        this.totalTokens += usage.totalTokens;
    }

    getUsage(): TokenUsage {
        return {
            promptTokens: this.promptTokens,
            completionTokens: this.completionTokens,
            totalTokens: this.totalTokens,
        };
    }

    getCost(model: LLMModel = 'gpt-4o-mini'): CostBreakdown {
        return calculateCost(this.getUsage(), model);
    }

    reset(): void {
        this.promptTokens = 0;
        this.completionTokens = 0;
        this.totalTokens = 0;
    }
}
