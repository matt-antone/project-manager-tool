import { NextRequest, NextResponse } from "next/server";
import { clearAuthSessionCookies } from "@/lib/server-auth";

function redirectHome(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/", request.url));
  clearAuthSessionCookies(response);
  return response;
}

export async function GET(request: NextRequest) {
  return redirectHome(request);
}

export async function POST(request: NextRequest) {
  return redirectHome(request);
}
