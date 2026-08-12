import { z } from "zod";

export const roleSchema = z.enum(["orchestrator", "worker", "verifier"]);
export type AgentRole = z.infer<typeof roleSchema>;

export const modelProfileSchema = z.enum([
  "luna_max",
  "terra_high",
  "sol_high",
  "sol_max",
]);
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const executionRouteSchema = z.enum([
  "orchestrated",
  "single_worker",
]);
export type ExecutionRoute = z.infer<typeof executionRouteSchema>;

export interface ModelProfileDefinition {
  model: string;
  reasoningEffort: "high" | "max";
}

export const modelProfiles: Readonly<Record<ModelProfile, ModelProfileDefinition>> = {
  luna_max: {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  },
  terra_high: {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
  },
  sol_high: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
  sol_max: {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  },
};

export const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cache_write_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
});
export type AgentUsage = z.infer<typeof usageSchema>;

export const emptyUsage = (): AgentUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
});

export function addUsage(left: AgentUsage, right: AgentUsage | null): AgentUsage {
  if (right === null) {
    return left;
  }

  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens:
      left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens:
      left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

export const orchestrationPlanSchema = z.object({
  status: z.enum(["ready", "needs_input", "blocked"]),
  summary: z.string().min(1),
  worker_task: z.string().min(1).nullable(),
  worker_profile: modelProfileSchema.nullable(),
  verifier_profile: modelProfileSchema.nullable(),
  completion_criteria: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;

export const agentOutcomeSchema = z.object({
  status: z.enum(["completed", "needs_input", "blocked", "failed"]),
  summary: z.string().min(1),
  result_path: z.string().min(1).nullable(),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});
export type AgentOutcome = z.infer<typeof agentOutcomeSchema>;

export const fastWorkerOutcomeSchema = agentOutcomeSchema.extend({
  status: z.enum([
    "completed",
    "needs_input",
    "blocked",
    "failed",
    "escalate",
  ]),
});
export type FastWorkerOutcome = z.infer<typeof fastWorkerOutcomeSchema>;

export const verificationFindingSchema = z.object({
  issue: z.string().min(1),
  evidence: z.string().min(1),
});
export type VerificationFinding = z.infer<typeof verificationFindingSchema>;

export const verificationOutcomeSchema = z.object({
  status: z.enum(["passed", "findings", "needs_input", "blocked"]),
  summary: z.string().min(1),
  findings: z.array(verificationFindingSchema),
  result_path: z.string().min(1).nullable(),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const workflowRunInputSchema = z
  .object({
    workflow_id: z.string().uuid().optional(),
    request: z.string().trim().min(1).max(100_000),
    workspace: z.string().trim().min(1).optional(),
    execution_route: executionRouteSchema.default("orchestrated"),
    completion_criteria: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine((input, context) => {
    if (
      input.execution_route === "single_worker" &&
      input.completion_criteria.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["completion_criteria"],
        message:
          "single_worker requires at least one observable completion criterion",
      });
    }
  });
export type WorkflowRunInput = z.input<typeof workflowRunInputSchema>;
export type ParsedWorkflowRunInput = z.output<typeof workflowRunInputSchema>;

export const workflowRunOutputSchema = z.object({
  workflow_id: z.string().uuid(),
  status: z.enum(["completed", "needs_input", "blocked", "failed"]),
  summary: z.string().min(1),
  task_dir: z.string().min(1),
  result_path: z.string().min(1).nullable(),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
  usage: usageSchema,
  execution_route: executionRouteSchema,
  retry_route: z.literal("orchestrated").nullable(),
});
export type WorkflowRunOutput = z.infer<typeof workflowRunOutputSchema>;
