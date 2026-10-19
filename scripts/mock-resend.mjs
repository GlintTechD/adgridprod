/**
 * Local stand-in for the Resend API (`POST /emails`).
 *
 * Lets you verify the exact production email payload - sender, recipient,
 * subject, HTML and the 6-digit code inside it - without a Resend account or a
 * real send. Pair it with RESEND_API_URL.
 *
 *   node scripts/mock-resend.mjs                     # listens on 127.0.0.1:4200
 *   RESEND_API_URL=http://127.0.0.1:4200/emails \
 *   RESEND_API_KEY=re_local_test \
 *   RESEND_FROM_EMAIL="ADGRID Security <no-reply@adgrids.test>" \
 *   NODE_ENV=production PORT=3300 npx tsx server.ts
 *
 * Inspect what was captured:
 *   curl localhost:4200/__inbox
 *   curl "localhost:4200/__last-otp?to=you@example.com"
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_RESEND_PORT || 4200);

/** @type {Array<{id: string, from: string, to: string[], subject: string, html: string, receivedAt: string, otp: string | null}>} */
const inbox = [];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'POST' && url.pathname.endsWith('/emails')) {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return sendJson(res, 401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' });
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 422, { statusCode: 422, name: 'validation_error', message: 'Invalid JSON body' });
    }

    if (!parsed.from || !parsed.to || !parsed.subject) {
      return sendJson(res, 422, {
        statusCode: 422,
        name: 'validation_error',
        message: 'from, to and subject are required',
      });
    }

    // Detect a Resend-style "domain not verified" rejection on request.
    if (String(parsed.from).includes('unverified-domain')) {
      return sendJson(res, 403, {
        statusCode: 403,
        name: 'validation_error',
        message: 'The adgrids.test domain is not verified. Please, add and verify your domain on Resend.',
      });
    }

    const recipients = Array.isArray(parsed.to) ? parsed.to : [parsed.to];

    // Extract the 6-digit code, ignoring the hex colours that appear earlier in
    // the email template (e.g. `color: #181716`), which a naive \d{6} would match.
    const html = String(parsed.html || '');
    const otpMatch =
      html.match(/(?<![#&\w])([0-9]{6})(?![0-9a-fA-F])/) || html.match(/(?<![#&\w])([0-9]{6})(?![\w])/);

    const record = {
      id: `mock-${Math.random().toString(36).slice(2, 12)}`,
      from: parsed.from,
      to: recipients,
      subject: parsed.subject,
      html: parsed.html,
      receivedAt: new Date().toISOString(),
      otp: otpMatch ? otpMatch[1] : null,
    };

    inbox.push(record);
    console.log(
      `[mock-resend] ${record.id} from=${record.from} to=${recipients.join(',')} subject="${record.subject}"` +
        (record.otp ? ` otp=${record.otp}` : '')
    );

    return sendJson(res, 200, { id: record.id });
  }

  if (url.pathname === '/__inbox') {
    return sendJson(res, 200, { count: inbox.length, messages: inbox });
  }

  if (url.pathname === '/__last-otp') {
    const to = String(url.searchParams.get('to') || '').toLowerCase();
    const match = [...inbox].reverse().find((m) => m.otp && (!to || m.to.includes(to)));
    return sendJson(res, 200, { to: to || null, otp: match?.otp || null, subject: match?.subject || null });
  }

  if (url.pathname === '/__reset' && req.method === 'POST') {
    inbox.length = 0;
    return sendJson(res, 200, { cleared: true });
  }

  return sendJson(res, 404, { message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-resend] Resend stand-in on http://127.0.0.1:${PORT}`);
  console.log(`[mock-resend] set RESEND_API_URL="http://127.0.0.1:${PORT}/emails"`);
});
