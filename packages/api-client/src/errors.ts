import { ProblemSchema, type Problem } from "@grooming/contracts";

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.title);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export function toApiError(status: number, bodyText: string): ApiError {
  try {
    const parsed = ProblemSchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) return new ApiError(status, parsed.data);
  } catch {
    // not JSON: fall through to the generic problem
  }
  return new ApiError(status, {
    type: "about:blank",
    title: "Error",
    status,
    code: status >= 500 ? "INTERNAL" : "BAD_REQUEST",
  });
}
