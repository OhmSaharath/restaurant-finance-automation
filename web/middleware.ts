import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// ── Default-Deny Whitelist ──
// Only these top-level routes are public. Every other route requires an
// authenticated session; unauthenticated visitors are bounced to /login.

const PUBLIC_ROUTES = [
  "/",
  "/login",
  "/register",
  "/auth",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(`${p}/`))
  );
}

// Middleware runs at the edge where only NEXT_PUBLIC_* vars are available; if they
// are absent we cannot verify a session, so deny-by-default with a clean redirect.

function authClient(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;


 if (!url || !anon) {

   return null;
  }
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll() {},
    },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow framework/static assets (these never hit the matcher anyway,
  // but keep it explicit yet defensive).
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  if (isPublic(pathname)) {
    // Authenticated users hitting auth gates (login/register) go straight to dashboard.



    if (pathname === "/login" || pathname === "/register") {
      const supabase = authClient(request);
      if (supabase) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const url = request.nextUrl.clone();
          url.pathname = "/dashboard";
          url.search = "";
          return NextResponse.redirect(url);
        }
      }
    }
    return NextResponse.next();
  }

  // Default-deny: authenticate all non-public routes.


  const supabase = authClient(request);
  if (!supabase) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirectedFrom", pathname);
    return NextResponse.redirect(url);
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();


 if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirectedFrom", pathname);
    return NextResponse.redirect(url);
  }


 return NextResponse.next();
}

export const config = {
  // Match all request paths except framework/image/favicon assets.


  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};