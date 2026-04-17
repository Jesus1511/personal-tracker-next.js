const RIZE_GRAPHQL_ENDPOINT = "https://api.rize.io/api/v1/graphql";

type GraphQLError = {
  message: string;
};

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: GraphQLError[];
};

/**
 * Executes a GraphQL operation against the Rize API from the server.
 * Keeps the API key on the backend and normalizes error handling.
 */
export async function queryRize<TData>(
  query: string,
  variables: Record<string, unknown>,
): Promise<TData> {
  const apiKey = process.env.RIZE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing RIZE_API_KEY");
  }

  const response = await fetch(RIZE_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Rize API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GraphQLResponse<TData>;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Rize API returned an empty response");
  }

  return payload.data;
}
