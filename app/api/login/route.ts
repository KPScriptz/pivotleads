import { NextResponse } from 'next/server';

// Verifies the shared team password against the server-only SITE_PASSWORD env var,
// then sets an httpOnly session cookie the middleware checks. The password itself
// never reaches the browser bundle.
export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: '' }));
  const expected = process.env.SITE_PASSWORD;
  if (!expected || typeof password !== 'string' || password !== expected) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('pl_session', process.env.SESSION_TOKEN || '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
