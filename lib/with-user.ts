import { requireUser } from "@/lib/auth";
import { serverError, unauthorized } from "@/lib/http";

export type RouteUser = Awaited<ReturnType<typeof requireUser>>;

/**
 * Standard authenticated-route envelope: resolve the user via `requireUser`,
 * run the handler, and map thrown errors to 401 (auth/token/workspace) or 500.
 * The handler may still return `ok()`/`badRequest()`/etc. directly.
 *
 * Only for routes whose error handling IS exactly this envelope. Routes that map
 * additional error types (ZodError, SyntaxError, duplicate-key, notFound,
 * conflict, …) keep their own try/catch so their behavior is preserved.
 */
export function withUser<Ctx = unknown>(
  logTag: string | null,
  handler: (request: Request, user: RouteUser, context: Ctx) => Promise<Response>
) {
  return async (request: Request, context: Ctx): Promise<Response> => {
    try {
      const user = await requireUser(request);
      return await handler(request, user, context);
    } catch (error) {
      if (logTag) {
        console.error(logTag, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
        return unauthorized(error.message);
      }
      return serverError();
    }
  };
}
