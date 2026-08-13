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

export const usageStatusSchema = z.enum([
  "measured",
  "estimated",
  "partial",
  "unknown",
]);
export type UsageStatus = z.infer<typeof usageStatusSchema>;

export const workflowFailureKindSchema = z
  .enum([
    "execution_error",
    "cyber_policy",
    "verification_rejected",
    "task_failed",
    "route_escalation",
  ])
  .nullable();
export type WorkflowFailureKind = z.infer<typeof workflowFailureKindSchema>;

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

const emptyStringsSchema = z.array(z.string().min(1)).length(0);

export const orchestrationPlanSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    summary: z.string().min(1),
    worker_task: z.string().min(1),
    worker_profile: modelProfileSchema,
    verifier_profile: modelProfileSchema,
    completion_criteria: z.array(z.string().min(1)).min(1),
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    worker_task: z.null(),
    worker_profile: z.null(),
    verifier_profile: z.null(),
    completion_criteria: emptyStringsSchema,
    questions: z.array(z.string().min(1)).min(1),
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("blocked"),
    summary: z.string().min(1),
    worker_task: z.null(),
    worker_profile: z.null(),
    verifier_profile: z.null(),
    completion_criteria: emptyStringsSchema,
    questions: emptyStringsSchema,
    blocker: z.string().min(1),
  }),
]);
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;

// OpenAI Structured Outputs requires a root object and rejects the top-level
// `oneOf` emitted for Zod discriminated unions. These wire schemas describe
// the common object shape accepted from the model; the discriminated unions
// above and below remain the authoritative semantic validators.
export const orchestrationPlanWireSchema = z.object({
  status: z.enum(["ready", "needs_input", "blocked"]),
  summary: z.string().min(1),
  worker_task: z.string().min(1).nullable(),
  worker_profile: modelProfileSchema.nullable(),
  verifier_profile: modelProfileSchema.nullable(),
  completion_criteria: z.array(z.string().min(1)),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});

const resultPathSchema = z.string().min(1).nullable();

export const agentOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    summary: z.string().min(1),
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    result_path: resultPathSchema,
    questions: z.array(z.string().min(1)).min(1),
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("blocked"),
    summary: z.string().min(1),
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    summary: z.string().min(1),
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.string().min(1),
  }),
]);
export type AgentOutcome = z.infer<typeof agentOutcomeSchema>;

export const agentOutcomeWireSchema = z.object({
  status: z.enum(["completed", "needs_input", "blocked", "failed"]),
  summary: z.string().min(1),
  result_path: resultPathSchema,
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});

export const fastWorkerOutcomeSchema = z.discriminatedUnion("status", [
  ...agentOutcomeSchema.options,
  z.object({
    status: z.literal("escalate"),
    summary: z.string().min(1),
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
]);
export type FastWorkerOutcome = z.infer<typeof fastWorkerOutcomeSchema>;

export const fastWorkerOutcomeWireSchema = z.object({
  status: z.enum([
    "completed",
    "needs_input",
    "blocked",
    "failed",
    "escalate",
  ]),
  summary: z.string().min(1),
  result_path: resultPathSchema,
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});

export const verificationFindingSchema = z.object({
  issue: z.string().min(1),
  evidence: z.string().min(1),
});
export type VerificationFinding = z.infer<typeof verificationFindingSchema>;

const emptyFindingsSchema = z.array(verificationFindingSchema).length(0);

export const verificationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("passed"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("findings"),
    summary: z.string().min(1),
    findings: z.array(verificationFindingSchema).min(1),
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    result_path: resultPathSchema,
    questions: z.array(z.string().min(1)).min(1),
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("blocked"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.string().min(1),
  }),
]);
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const verificationOutcomeWireSchema = z.object({
  status: z.enum(["passed", "findings", "needs_input", "blocked"]),
  summary: z.string().min(1),
  findings: z.array(verificationFindingSchema),
  result_path: resultPathSchema,
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
});

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
  status: z.enum([
    "completed",
    "needs_input",
    "blocked",
    "failed",
    "cancelled",
  ]),
  summary: z.string().min(1),
  task_dir: z.string().min(1),
  result_path: z.string().min(1).nullable(),
  questions: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
  usage: usageSchema,
  usage_status: usageStatusSchema.default("unknown"),
  execution_route: executionRouteSchema,
  retry_route: z.literal("orchestrated").nullable(),
  failure_kind: workflowFailureKindSchema.default(null),
  recovery_requires_user_approval: z.boolean().default(false),
})
  .superRefine((output, context) => {
    if (output.status === "completed") {
      if (output.questions.length !== 0 || output.blocker !== null) {
        context.addIssue({
          code: "custom",
          message: "completed outcomes cannot contain questions or a blocker",
        });
      }
    } else if (output.status === "needs_input") {
      if (output.questions.length === 0 || output.blocker !== null) {
        context.addIssue({
          code: "custom",
          message: "needs_input requires questions and cannot contain a blocker",
        });
      }
    } else if (output.questions.length !== 0 || output.blocker === null) {
      context.addIssue({
        code: "custom",
        message: `${output.status} requires a blocker and cannot contain questions`,
      });
    }

    if (output.status === "failed" && output.failure_kind === null) {
      context.addIssue({
        code: "custom",
        path: ["failure_kind"],
        message: "failed outcomes require a failure kind",
      });
    } else if (output.status !== "failed" && output.failure_kind !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure_kind"],
        message: `${output.status} outcomes cannot contain a failure kind`,
      });
    }

    const approvalExpected = output.failure_kind === "cyber_policy";
    if (output.recovery_requires_user_approval !== approvalExpected) {
      context.addIssue({
        code: "custom",
        path: ["recovery_requires_user_approval"],
        message:
          "recovery approval is required exactly for cyber_policy failures",
      });
    }
    if (approvalExpected && output.retry_route !== null) {
      context.addIssue({
        code: "custom",
        path: ["retry_route"],
        message: "cyber_policy failures cannot advertise an automatic retry route",
      });
    }
  });
export type WorkflowRunOutput = z.infer<typeof workflowRunOutputSchema>;

export const recoveryDecisionInputSchema = z.object({
  workflow_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  note: z.string().trim().min(1).max(10_000).optional(),
});
export type RecoveryDecisionInput = z.infer<
  typeof recoveryDecisionInputSchema
>;

export const recoveryDecisionOutputSchema = z.object({
  workflow_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  recorded_at: z.string().min(1),
});
export type RecoveryDecisionOutput = z.infer<
  typeof recoveryDecisionOutputSchema
>;
