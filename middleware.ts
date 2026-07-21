import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Lightweight shared-password gate for the team beta. If SESSION_TOKEN isn't set
// (e.g. local dev without the env), the gate is disabled so no one gets locked out.
const COOKIE = 'pl_session';

export function middleware(req: NextRequest) {
  const token = process.env.SESSION_TOKEN;
  if (!token) return NextResponse.next();
  if (req.cookies.get(COOKIE)?.value === token) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

// Protect everything except the login page, its API, Next internals, and the icons/manifest.
export const config = {
  matcher: ['/((?!login|api/login|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest).*)'],
};
