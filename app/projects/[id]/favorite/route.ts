import { badRequest, ok } from "@/lib/http";
import { addProjectFavorite, removeProjectFavorite } from "@/lib/repositories";
import { withUser, type RouteUser } from "@/lib/with-user";
import { z } from "zod";

const idSchema = z.string().uuid();

type RouteContext = { params: Promise<{ id: string }> };

function favoriteHandler(mutate: (userId: string, projectId: string) => Promise<void>) {
  return async (_request: Request, user: RouteUser, { params }: RouteContext) => {
    const { id } = await params;
    if (!idSchema.safeParse(id).success) {
      return badRequest("Invalid project id");
    }
    await mutate(user.id, id);
    return ok({});
  };
}

export const POST = withUser<RouteContext>("project_favorite_failed", favoriteHandler(addProjectFavorite));
export const DELETE = withUser<RouteContext>("project_favorite_failed", favoriteHandler(removeProjectFavorite));
