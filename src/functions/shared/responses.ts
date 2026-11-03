import type { ApiError, ApiErrorCode, ApiResponse, ValidationIssue } from '../../contracts/api.js'

export function ok<T>(value: T): ApiResponse<T> {
  return { ok: true, value }
}

export function fail<T>(code: ApiErrorCode, message: string, issues?: ValidationIssue[]): ApiResponse<T> {
  const error: ApiError = { code, message, ...(issues !== undefined && { issues }) }
  return { ok: false, error }
}
