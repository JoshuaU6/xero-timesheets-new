export interface XeroErrorInfo {
  message: string;
  status?: number;
  httpStatusCode?: string;
}

export function extractXeroError(xeroErrorResponse: any): XeroErrorInfo {
  const parsedError = JSON.parse(xeroErrorResponse);

  // Extract status information
  const status =
    parsedError?.response?.statusCode || parsedError?.response?.status;
  const httpStatusCode =
    parsedError?.response?.data?.httpStatusCode ||
    parsedError?.response?.body?.httpStatusCode;

  // Prefer deeply nested problem
  const problem =
    parsedError?.response?.data?.problem ||
    parsedError?.response?.body?.problem ||
    parsedError?.body?.problem;

  let message = "An unknown error occurred.";

  if (problem) {
    // Collect invalidObjects error messages
    if (problem.invalidObjects && problem.invalidObjects.length > 0) {
      const errors = problem.invalidObjects
        .map((obj: any) => obj.errorMessage)
        .filter(Boolean);

      if (errors.length > 0) {
        message = errors.join("; ");
      }
    } else {
      // Fallbacks
      if (problem.detail) message = problem.detail;
      else if (problem.title) message = problem.title;
    }
  }

  return {
    message,
    status,
    httpStatusCode,
  };
}
