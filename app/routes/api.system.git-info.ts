import { json, type LoaderFunction, type LoaderFunctionArgs } from '@remix-run/cloudflare';

// --- Configuration ---
// Set to true to enable detailed logging of GitHub API errors, including response body.
// Set to false to disable detailed error logging in production.
const DEBUG_MODE = true;

// Define a User-Agent string for GitHub API requests.
// Replace 'YourAppName/1.0 (you@example.com)' with your actual application name and contact info.
const GITHUB_USER_AGENT = 'Bolt.DIY/1.0 (YourAppName/1.0)';
// --- End of Configuration ---

interface GitInfo {
  local: {
    commitHash: string;
    branch: string;
    commitTime: string;
    author: string;
    email: string;
    remoteUrl: string;
    repoName: string;
  };
  github?: {
    currentRepo?: {
      fullName: string;
      defaultBranch: string;
      stars: number;
      forks: number;
      openIssues?: number;
    };
  };
  isForked?: boolean;
  timestamp?: string;
}

// Define context type
interface AppContext {
  env?: {
    GITHUB_ACCESS_TOKEN?: string;
  };
}

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  languages_url: string;
}

interface GitHubGist {
  id: string;
  html_url: string;
  description: string;
}

// These values will be replaced at build time
declare const __COMMIT_HASH: string;
declare const __GIT_BRANCH: string;
declare const __GIT_COMMIT_TIME: string;
declare const __GIT_AUTHOR: string;
declare const __GIT_EMAIL: string;
declare const __GIT_REMOTE_URL: string;
declare const __GIT_REPO_NAME: string;

/*
 * Remove unused variable to fix linter error
 * declare const __GIT_REPO_URL: string;
 */

export const loader: LoaderFunction = async ({ request, context }: LoaderFunctionArgs & { context: AppContext }) => {
  console.log('Git info API called with URL:', request.url);

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200, // Added status 200 for clarity
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Ensure Authorization is allowed
      },
    });
  }

  // Standard CORS headers for actual responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // Reflect allowed methods
  };

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  console.log('Git info action:', action);

  // --- GitHub API Actions ---
  if (action === 'getUser' || action === 'getRepos' || action === 'getOrgs' || action === 'getActivity') {
    // Determine the token source
    const serverGithubToken = process.env.GITHUB_ACCESS_TOKEN || context.env?.GITHUB_ACCESS_TOKEN;
    const cookieToken = request.headers
      .get('Cookie')
      ?.split(';')
      .find((cookie) => cookie.trim().startsWith('githubToken='))
      ?.split('=')[1];
    const authHeader = request.headers.get('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    // Prioritize header token, then server env, then cookie
    const token = headerToken || serverGithubToken || cookieToken;
    const tokenSource = headerToken ? 'auth header' : serverGithubToken ? 'server env' : cookieToken ? 'cookie' : 'none';

    console.log('Using GitHub token from:', tokenSource);

    if (!token) {
      console.error('No GitHub token available');
      return json(
        { error: 'Authentication required: No GitHub token available.' },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }

    // Define common headers for GitHub API calls
    const githubApiHeaders = {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': GITHUB_USER_AGENT, // Add required User-Agent
    };

    try {
      // --- Get User Action ---
      if (action === 'getUser') {
        const response = await fetch('https://api.github.com/user', {
          headers: githubApiHeaders,
        });

        if (!response.ok) {
          const errorStatus = response.status;
          let errorBody = '';
          // Log detailed error only if DEBUG_MODE is true
          if (DEBUG_MODE) {
            errorBody = await response.text();
            console.error(`GitHub getUser API error: Status ${errorStatus}, Body: ${errorBody}`);
          } else {
            console.error(`GitHub getUser API error: Status ${errorStatus}`);
          }
          // Use a more specific error message if possible from the body in debug mode
          const errorMessage = DEBUG_MODE && errorBody ? `GitHub API error: ${errorStatus} - ${errorBody}` : `GitHub API error: ${errorStatus}`;
          throw new Error(errorMessage);
        }

        const userData = await response.json();
        return json({ user: userData }, { headers: corsHeaders });
      }

      // --- Get Repos Action ---
      if (action === 'getRepos') {
        const reposResponse = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: githubApiHeaders,
        });

        if (!reposResponse.ok) {
          const errorStatus = reposResponse.status;
          let errorBody = '';
          if (DEBUG_MODE) {
            errorBody = await reposResponse.text();
            console.error(`GitHub getRepos API error: Status ${errorStatus}, Body: ${errorBody}`);
          } else {
            console.error(`GitHub getRepos API error: Status ${errorStatus}`);
          }
          const errorMessage = DEBUG_MODE && errorBody ? `GitHub API error: ${errorStatus} - ${errorBody}` : `GitHub API error: ${errorStatus}`;
          throw new Error(errorMessage);
        }
        const repos = (await reposResponse.json()) as GitHubRepo[];

        // Get user's gists (optional, handle potential failure gracefully)
        let gists: GitHubGist[] = [];
        try {
          const gistsResponse = await fetch('https://api.github.com/gists', {
            headers: githubApiHeaders,
          });
          if (gistsResponse.ok) {
            gists = (await gistsResponse.json()) as GitHubGist[];
          } else if (DEBUG_MODE) {
            // Log gist fetch error only in debug mode, but don't fail the whole request
            const errorStatus = gistsResponse.status;
            const errorBody = await gistsResponse.text();
            console.warn(`GitHub getGists minor API error: Status ${errorStatus}, Body: ${errorBody}`);
          } else {
             console.warn(`GitHub getGists minor API error: Status ${gistsResponse.status}`);
          }
        } catch (gistError) {
           if (DEBUG_MODE) {
             console.warn(`Error fetching gists: ${gistError instanceof Error ? gistError.message : gistError}`);
           }
        }


        // Calculate language statistics
        const languageStats: Record<string, number> = {};
        let totalStars = 0;
        let totalForks = 0;

        for (const repo of repos) {
          totalStars += repo.stargazers_count || 0;
          totalForks += repo.forks_count || 0;
          if (repo.language && repo.language !== 'null') {
            languageStats[repo.language] = (languageStats[repo.language] || 0) + 1;
          }
          // Fetching languages per repo is too intensive - avoid
        }

        return json(
          {
            repos,
            stats: {
              totalStars,
              totalForks,
              languages: languageStats,
              totalGists: gists.length,
            },
          },
          { headers: corsHeaders },
        );
      }

      // --- Get Orgs Action ---
      if (action === 'getOrgs') {
        const response = await fetch('https://api.github.com/user/orgs', {
          headers: githubApiHeaders,
        });

        if (!response.ok) {
          const errorStatus = response.status;
          let errorBody = '';
          if (DEBUG_MODE) {
            errorBody = await response.text();
            console.error(`GitHub getOrgs API error: Status ${errorStatus}, Body: ${errorBody}`);
          } else {
             console.error(`GitHub getOrgs API error: Status ${errorStatus}`);
          }
          const errorMessage = DEBUG_MODE && errorBody ? `GitHub API error: ${errorStatus} - ${errorBody}` : `GitHub API error: ${errorStatus}`;
          throw new Error(errorMessage);
        }

        const orgs = await response.json();
        return json({ organizations: orgs }, { headers: corsHeaders });
      }

      // --- Get Activity Action ---
      if (action === 'getActivity') {
        // Attempt to get username from token if not in cookie (more robust)
        let username = request.headers
          .get('Cookie')
          ?.split(';')
          .find((cookie) => cookie.trim().startsWith('githubUsername='))
          ?.split('=')[1];

        // If username not in cookie, try fetching from /user endpoint
        if (!username) {
          if (DEBUG_MODE) console.log('Username not in cookie, attempting to fetch from /user');
           try {
             const userResponse = await fetch('https://api.github.com/user', { headers: githubApiHeaders });
             if (userResponse.ok) {
               const userData = await userResponse.json();
               username = userData.login;
               if (DEBUG_MODE) console.log(`Fetched username: ${username}`);
             } else {
                if (DEBUG_MODE) {
                  const errorStatus = userResponse.status;
                  const errorBody = await userResponse.text();
                  console.error(`Failed to fetch username for activity: Status ${errorStatus}, Body: ${errorBody}`);
                } else {
                   console.error(`Failed to fetch username for activity: Status ${userResponse.status}`);
                }
             }
           } catch (userFetchError) {
             if (DEBUG_MODE) {
                console.error(`Error fetching username for activity: ${userFetchError instanceof Error ? userFetchError.message : userFetchError}`);
             }
           }
        }


        if (!username) {
          console.error('GitHub username could not be determined for activity feed.');
          return json(
            { error: 'GitHub username could not be determined.' },
            {
              status: 400, // Bad Request as username is missing
              headers: corsHeaders,
            },
          );
        }

        const response = await fetch(`https://api.github.com/users/${username}/events?per_page=30`, {
          headers: githubApiHeaders, // Use the same headers including User-Agent
        });

        if (!response.ok) {
          const errorStatus = response.status;
          let errorBody = '';
          if (DEBUG_MODE) {
            errorBody = await response.text();
            console.error(`GitHub getActivity API error: Status ${errorStatus}, Body: ${errorBody}`);
          } else {
            console.error(`GitHub getActivity API error: Status ${errorStatus}`);
          }
          const errorMessage = DEBUG_MODE && errorBody ? `GitHub API error: ${errorStatus} - ${errorBody}` : `GitHub API error: ${errorStatus}`;
          throw new Error(errorMessage);
        }

        const events = await response.json();
        return json({ recentActivity: events }, { headers: corsHeaders });
      }

    // Catch block for GitHub API related errors within the action block
    } catch (error) {
      // Log the specific error thrown from the try block
      console.error('GitHub API action failed:', error instanceof Error ? error.message : error);
      // Return a 500 Internal Server Error, as the server failed to process the request
      return json(
        { error: 'Failed to process GitHub API request.', details: error instanceof Error ? error.message : 'Unknown internal error' },
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  }

  // --- Fallback/Default Action (if no specific GitHub action matched) ---
  // This part provides local git info injected at build time.
  const gitInfo: GitInfo = {
    local: {
      commitHash: typeof __COMMIT_HASH !== 'undefined' ? __COMMIT_HASH : 'development',
      branch: typeof __GIT_BRANCH !== 'undefined' ? __GIT_BRANCH : 'main',
      commitTime: typeof __GIT_COMMIT_TIME !== 'undefined' ? __GIT_COMMIT_TIME : new Date().toISOString(),
      author: typeof __GIT_AUTHOR !== 'undefined' ? __GIT_AUTHOR : 'development',
      email: typeof __GIT_EMAIL !== 'undefined' ? __GIT_EMAIL : 'development@local',
      remoteUrl: typeof __GIT_REMOTE_URL !== 'undefined' ? __GIT_REMOTE_URL : 'local',
      repoName: typeof __GIT_REPO_NAME !== 'undefined' ? __GIT_REPO_NAME : 'bolt.diy',
    },
    timestamp: new Date().toISOString(),
  };

  return json(gitInfo, { headers: corsHeaders });
};
