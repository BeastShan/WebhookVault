import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
    return new NextResponse('Loopback only', { status: 403 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== `http://${host}`) return new NextResponse('Cross-origin request denied', { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static).*)'] };
