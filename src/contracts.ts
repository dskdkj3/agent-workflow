import { z } from "zod";

export const roleSchema = z.enum(["orchestrator", "worker", "verifier"]);
export type AgentRole = z.infer<typeof roleSchema>;

export const reasoningEffortSchema = z.enum(["high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const modelProfileSchema = z.enum([
  "luna_high",
  "luna_xhigh",
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
  reasoningEffort: ReasoningEffort;
}

export const modelProfiles: Readonly<Record<ModelProfile, ModelProfileDefinition>> = {
  luna_high: {
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  },
  luna_xhigh: {
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
  },
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

export const workerTaskClassSchema = z.enum([
  "short_bounded",
  "bounded_execution",
  "long_horizon_execution",
  "bounded_judgment",
  "irreducible_synthesis",
  "critical_deliberation",
]);
export type WorkerTaskClass = z.infer<typeof workerTaskClassSchema>;

export const verifierTaskClassSchema = z.enum([
  "mechanical_check",
  "bounded_evidence_review",
  "irreducible_review",
  "critical_review",
]);
export type VerifierTaskClass = z.infer<typeof verifierTaskClassSchema>;

export const workerRouteProfiles: Readonly<Record<WorkerTaskClass, ModelProfile>> = {
  short_bounded: "luna_high",
  bounded_execution: "luna_xhigh",
  long_horizon_execution: "luna_max",
  bounded_judgment: "terra_high",
  irreducible_synthesis: "sol_high",
  critical_deliberation: "sol_max",
};

export const verifierRouteProfiles: Readonly<
  Record<VerifierTaskClass, ModelProfile>
> = {
  mechanical_check: "luna_high",
  bounded_evidence_review: "terra_high",
  irreducible_review: "sol_high",
  critical_review: "sol_max",
};

export const workerRouteDecisionSchema = z.object({
  task_class: workerTaskClassSchema,
  residual_burden: z.string().min(1),
  why_lower_cost_route_is_insufficient: z.string().min(1),
  upgrade_trigger: z.string().min(1),
});
export type WorkerRouteDecision = z.infer<typeof workerRouteDecisionSchema>;

export const verifierRouteDecisionSchema = z.object({
  task_class: verifierTaskClassSchema,
  residual_burden: z.string().min(1),
  why_lower_cost_route_is_insufficient: z.string().min(1),
  upgrade_trigger: z.string().min(1),
});
export type VerifierRouteDecision = z.infer<
  typeof verifierRouteDecisionSchema
>;

const orchestrationPlanModelSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    summary: z.string().min(1),
    worker_task: z.string().min(1),
    worker_route: workerRouteDecisionSchema,
    verifier_route: verifierRouteDecisionSchema,
    completion_criteria: z.array(z.string().min(1)).min(1),
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    worker_task: z.null(),
    worker_route: z.null(),
    verifier_route: z.null(),
    completion_criteria: emptyStringsSchema,
    questions: z.array(z.string().min(1)).min(1),
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("blocked"),
    summary: z.string().min(1),
    worker_task: z.null(),
    worker_route: z.null(),
    verifier_route: z.null(),
    completion_criteria: emptyStringsSchema,
    questions: emptyStringsSchema,
    blocker: z.string().min(1),
  }),
]);

export const orchestrationPlanSchema = orchestrationPlanModelSchema.transform(
  (plan) =>
    plan.status === "ready"
      ? {
          ...plan,
          worker_profile: workerRouteProfiles[plan.worker_route.task_class],
          verifier_profile:
            verifierRouteProfiles[plan.verifier_route.task_class],
        }
      : {
          ...plan,
          worker_profile: null,
          verifier_profile: null,
        },
);
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;

const legacyOrchestrationPlanSchema = z.discriminatedUnion("status", [
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
]).transform((plan) => ({
  ...plan,
  worker_route: null,
  verifier_route: null,
}));

export const storedOrchestrationPlanSchema = z.union([
  orchestrationPlanSchema,
  legacyOrchestrationPlanSchema,
]);
export type StoredOrchestrationPlan = z.infer<
  typeof storedOrchestrationPlanSchema
>;

// OpenAI Structured Outputs requires a root object and rejects the top-level
// `oneOf` emitted for Zod discriminated unions. These wire schemas describe
// the common object shape accepted from the model; the discriminated unions
// above and below remain the authoritative semantic validators.
export const orchestrationPlanWireSchema = z.object({
  status: z.enum(["ready", "needs_input", "blocked"]),
  summary: z.string().min(1),
  worker_task: z.string().min(1).nullable(),
  worker_route: workerRouteDecisionSchema.nullable(),
  verifier_route: verifierRouteDecisionSchema.nullable(),
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

export const verificationEvidenceReferenceSchema = z.object({
  claim: z.string().min(1),
  artifact_path: z.string().min(1),
});
export type VerificationEvidenceReference = z.infer<
  typeof verificationEvidenceReferenceSchema
>;

const emptyFindingsSchema = z.array(verificationFindingSchema).length(0);
const evidenceReferencesSchema = z
  .array(verificationEvidenceReferenceSchema)
  .default([]);

export const verificationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("passed"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    evidence_references: evidenceReferencesSchema,
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("findings"),
    summary: z.string().min(1),
    findings: z.array(verificationFindingSchema).min(1),
    evidence_references: evidenceReferencesSchema,
    result_path: resultPathSchema,
    questions: emptyStringsSchema,
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    evidence_references: evidenceReferencesSchema,
    result_path: resultPathSchema,
    questions: z.array(z.string().min(1)).min(1),
    blocker: z.null(),
  }),
  z.object({
    status: z.literal("blocked"),
    summary: z.string().min(1),
    findings: emptyFindingsSchema,
    evidence_references: evidenceReferencesSchema,
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
  evidence_references: z.array(verificationEvidenceReferenceSchema),
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
  usage: usageSchema.nullable(),
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

    if (output.usage_status === "unknown" && output.usage !== null) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "unknown usage must not expose placeholder numeric values",
      });
    } else if (output.usage_status !== "unknown" && output.usage === null) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: `${output.usage_status} usage requires observed numeric values`,
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
