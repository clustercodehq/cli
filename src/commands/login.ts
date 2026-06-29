import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { createServer } from 'node:http';
import { readCredentials, writeCredentials } from '../lib/config.js';
import { getOrchestratorUrl, getPortalUrl } from '../lib/config.js';
import { restoreTty } from '../lib/tty.js';

/** Escape HTML special characters to prevent XSS when interpolating user-controlled strings. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function callbackPage(title: string, message: string, success: boolean, actionUrl?: string, actionLabel?: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeActionUrl = actionUrl ? encodeURI(actionUrl) : undefined;
  const safeActionLabel = actionLabel ? escapeHtml(actionLabel) : 'Continue';
  const icon = success
    ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10c0f0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>'
    : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>';

  const actionHtml = safeActionUrl
    ? `<a href="${safeActionUrl}" class="action">${safeActionLabel}</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="data:image/png;base64,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" />
  <title>${title} — ClusterCode</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1e1e1e;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      text-align: center;
      padding: 3rem 2.5rem;
      background: #252526;
      border: 1px solid #333;
      border-radius: 12px;
      max-width: 420px;
      width: 90%;
    }
    .icon { margin-bottom: 1.5rem; }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #fff;
    }
    p {
      color: #888;
      font-size: 0.95rem;
      line-height: 1.5;
    }
    .action {
      display: inline-block;
      margin-top: 1.25rem;
      padding: 0.6rem 1.5rem;
      background: #10c0f0;
      color: #fff;
      font-weight: 600;
      font-size: 0.95rem;
      border-radius: 6px;
      text-decoration: none;
      transition: opacity 0.15s;
    }
    .action:hover { opacity: 0.85; }
    .brand {
      margin-top: 2rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: #555;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${actionHtml}
    <div class="brand">CLUSTERCODE</div>
  </div>
</body>
</html>`;
}

function isHeadless(): boolean {
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return true;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
}

async function openBrowser(url: string): Promise<void> {
  const open = (await import('open')).default;
  await open(url);
}

async function loginWithBrowser(): Promise<{ success: boolean; error?: string }> {
  const portalUrl = getPortalUrl();

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;

    function done(success: boolean, error?: string) {
      clearTimeout(timeout);
      server.close();
      resolve({ success, error });
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname === '/callback') {
        const apiKey = url.searchParams.get('api_key');
        const email = url.searchParams.get('email');
        const error = url.searchParams.get('error');

        if (error) {
          const message = error.replace(/_/g, ' ');
          const setupUrl = url.searchParams.get('setup_url');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(callbackPage(
            'Authentication failed',
            setupUrl
              ? `${message}. Complete your account setup to continue.`
              : `${message}. Please return to your terminal and try again.`,
            false,
            setupUrl ?? undefined,
            'Complete setup',
          ));
          done(false, message);
          return;
        }

        if (apiKey && email) {
          writeCredentials({
            apiKey,
            email,
            createdAt: new Date().toISOString(),
          });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(callbackPage('You\'re logged in!', 'You can close this tab and return to your terminal.', true));
          done(true);
          return;
        }

        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(callbackPage('Missing credentials', 'The authentication response was incomplete. Please try again.', false));
        done(false);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        done(false);
        return;
      }

      const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
      const loginUrl = `${portalUrl}/login?redirect_url=${encodeURIComponent(callbackUrl)}&cli=true`;

      clack.log.info(`Opening browser for authentication...\n  ${pc.dim(loginUrl)}`);

      if (process.env.CLUSTERCODE_NO_OPEN_BROWSER) {
        clack.log.info(`Visit this URL manually:\n  ${pc.cyan(loginUrl)}`);
      } else {
        try {
          await openBrowser(loginUrl);
        } catch {
          clack.log.warn(`Could not open browser. Visit this URL manually:\n  ${pc.cyan(loginUrl)}`);
        }
      }

      const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
      timeout = setTimeout(() => {
        clack.log.error('Authentication timed out after 3 minutes.');
        clack.log.info(`Try again, or use ${pc.bold('clustercode login --no-browser')} to paste a token manually.`);
        done(false);
      }, TIMEOUT_MS);
    });
  });
}

async function loginWithToken(): Promise<boolean> {
  const token = await clack.text({
    message: 'Paste your API token:',
    placeholder: 'csk_live_...',
    validate: (value = '') => {
      if (!value.trim()) return 'Token is required';
    },
  });

  if (clack.isCancel(token)) {
    clack.cancel('Login cancelled.');
    return false;
  }

  const email = await clack.text({
    message: 'Email associated with this token:',
    validate: (value = '') => {
      if (!value.trim()) return 'Email is required';
      if (!value.includes('@')) return 'Invalid email';
    },
  });

  if (clack.isCancel(email)) {
    clack.cancel('Login cancelled.');
    return false;
  }

  // Validate token against orchestrator API
  const orchestratorUrl = getOrchestratorUrl().replace(/^ws/, 'http').replace(/\/ws\/worker$/, '');
  try {
    const res = await fetch(`${orchestratorUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    });
    if (!res.ok) {
      clack.log.error('Token validation failed. Check that your token is correct.');
      return false;
    }
  } catch {
    clack.log.warn('Could not validate token — orchestrator unreachable. Saving anyway.');
  }

  writeCredentials({
    apiKey: token.trim(),
    email: email.trim(),
    createdAt: new Date().toISOString(),
  });

  return true;
}

export async function runLogin(options: { noBrowser?: boolean }): Promise<void> {
  const existing = readCredentials();
  if (existing) {
    const action = await clack.select({
      message: `Already logged in as ${pc.bold(existing.email)}`,
      options: [
        { value: 'keep', label: 'Keep current session' },
        { value: 'reauth', label: 'Log in with a different account' },
      ],
    });

    if (clack.isCancel(action) || action === 'keep') {
      clack.log.info(`Logged in as ${pc.bold(existing.email)}`);
      return;
    }
  }

  const useToken = options.noBrowser || isHeadless();

  let success: boolean;
  let errorMessage: string | undefined;

  if (useToken) {
    if (!options.noBrowser && isHeadless()) {
      clack.log.info('Headless environment detected — using token-based login.');
    }
    clack.log.info(
      `Generate a token at ${pc.cyan(getOrchestratorUrl().replace(/^ws/, 'http').replace(/\/ws\/worker$/, '') + '/settings/tokens')}`
    );
    success = await loginWithToken();
  } else {
    const spinner = clack.spinner();
    spinner.start('Waiting for browser authentication (3 min timeout)...');
    const result = await loginWithBrowser();
    success = result.success;
    errorMessage = result.error;
    spinner.stop(success ? 'Authentication complete' : 'Authentication failed');
  }

  if (success) {
    const creds = readCredentials();
    clack.log.success(`Logged in as ${pc.bold(creds?.email ?? 'unknown')}`);
  } else {
    clack.log.error(errorMessage || 'Login failed. Please try again.');
  }
}

export const loginCommand = new Command('login')
  .description('Authenticate with ClusterCode')
  .option('--no-browser', 'Use token-based login (for headless environments)')
  .action(async (options: { noBrowser?: boolean }) => {
    try {
      clack.intro(pc.bold('ClusterCode Login'));
      await runLogin(options);
      clack.outro('');
    } finally {
      restoreTty();
    }
  });
