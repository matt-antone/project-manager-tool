import { ok } from "@/lib/http";
import { listActiveUsers } from "@/lib/repositories";
import { withUser } from "@/lib/with-user";

export const GET = withUser(null, async () => {
  const users = await listActiveUsers();
  return ok({ users });
});
