import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';

// Allowed headers to forward to the target server
const ALLOW_HEADERS = [
  'accept-encoding',
  'accept-language',
  'accept',
  'access-control-allow-origin',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'dnt',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-authorization',
  'x-http-method-override',
  'x-requested-with',
];

// Headers to expose from the target server's response
const EXPOSE_HEADERS = [
  'accept-ranges',
  'age',
  'cache-control',
  'content-length',
  'content-language',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'pragma',
  'server',
  'transfer-encoding',
  'vary',
  'x-github-request-id',
  'x-redirected-url',
];

// Handle all HTTP methods
export async function action({ request, params }: ActionFunctionArgs) {
  return handleProxyRequest(request, params['*']);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return handleProxyRequest(request, params['*']);
}

async function handleProxyRequest(request: Request, path: string | undefined) {
  try {
    if (!path) {
      return json({ error: 'Invalid proxy URL format' }, { status: 400 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
          'Access-Control-Expose-Headers': EXPOSE_HEADERS.join(', '),
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const parts = path.match(/([^\/]+)\/?(.*)/);
    if (!parts) {
      return json({ error: 'Invalid path format' }, { status: 400 });
    }

    const domain = parts[1];
    const remainingPath = parts[2] || '';
    const url = new URL(request.url);
    const targetURL = `https://${domain}/${remainingPath}${url.search}`;

    console.log('Target URL:', targetURL);

    const headers = new Headers();
    for (const header of ALLOW_HEADERS) {
      if (request.headers.has(header)) {
        headers.set(header, request.headers.get(header)!);
      }
    }
    headers.set('Host', domain);

    // Set a default User-Agent only if none is provided
    if (!headers.has('user-agent')) {
      headers.set('User-Agent', 'MyProxyApp/1.0'); // Replace with your app name
    }

    // Require Authorization for GitHub API requests
    if (targetURL.startsWith('https://api.github.com') && !headers.has('authorization')) {
      return json({ error: 'Missing Authorization header for GitHub API' }, { status: 400 });
    }

    console.log('Request headers:', Object.fromEntries(headers.entries()));

    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
      redirect: 'follow',
    };

    if (!['GET', 'HEAD'].includes(request.method)) {
      fetchOptions.body = request.body;
    }

    const response = await fetch(targetURL, fetchOptions);
    console.log('Response status:', response.status);

    // Log error details if status is 400 or higher
    let responseBody = response.body;
    if (response.status >= 400) {
      const errorText = await response.text();
      console.error('Target server error:', response.status, errorText);
      responseBody = errorText;
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
    responseHeaders.set('Access-Control-Expose-Headers', EXPOSE_HEADERS.join(', '));

    for (const header of EXPOSE_HEADERS) {
      if (header === 'content-length') continue;
      if (response.headers.has(header)) {
        responseHeaders.set(header, response.headers.get(header)!);
      }
    }

    if (response.redirected) {
      responseHeaders.set('x-redirected-url', response.url);
    }

    console.log('Response headers:', Object.fromEntries(responseHeaders.entries()));

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return json(
      {
        error: 'Proxy error',
        message: error instanceof Error ? error.message : 'Unknown error',
        url: path ? `https://${path}` : 'Invalid URL',
      },
      { status: 500 },
    );
  }
}
