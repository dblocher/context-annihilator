import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { ApiError, ApiResponse, JobResult, StartJobResponse } from '../contracts/api.js'
import type { StartJobRequest } from '../contracts/context.js'

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly apiError?: ApiError,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

export type ClientOptions = {
  stackName: string
  region?: string
  profile?: string
}

export type WaitOptions = {
  pollIntervalMs: number
  timeoutMs: number
  onProgress?: (result: JobResult) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calls the ingress and result functions directly with IAM-signed Lambda invokes.
 * There is no public endpoint; the caller's AWS credentials authorize each call.
 */
export class AnnihilatorClient {
  private readonly lambda: LambdaClient
  private readonly ingressFunction: string
  private readonly resultFunction: string

  constructor(options: ClientOptions, lambda?: LambdaClient) {
    this.lambda =
      lambda ??
      new LambdaClient({
        ...(options.region && { region: options.region }),
        ...(options.profile && { profile: options.profile }),
      })
    this.ingressFunction = `${options.stackName}-ingress`
    this.resultFunction = `${options.stackName}-result`
  }

  async startJob(request: StartJobRequest): Promise<StartJobResponse> {
    return this.invoke<StartJobResponse>(this.ingressFunction, request)
  }

  async getResult(jobId: string, includeContent = true): Promise<JobResult> {
    return this.invoke<JobResult>(this.resultFunction, { jobId, includeContent })
  }

  /** Polls until the job is complete or failed. Downloads the full result when it was too large to inline. */
  async waitForResult(jobId: string, options: WaitOptions): Promise<JobResult> {
    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      const result = await this.getResult(jobId, true)
      options.onProgress?.(result)
      if (result.status !== 'running') {
        if (result.fullResultUrl) return this.download(result.fullResultUrl)
        return result
      }
      if (Date.now() + options.pollIntervalMs > deadline) {
        throw new ServiceError(
          `timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for job ${jobId} ` +
            `(${result.progress.resolved}/${result.progress.eligible} chunks resolved)`,
        )
      }
      await sleep(options.pollIntervalMs)
    }
  }

  private async download(url: string): Promise<JobResult> {
    const response = await fetch(url)
    if (!response.ok) throw new ServiceError(`downloading the full result failed with HTTP ${response.status}`)
    return (await response.json()) as JobResult
  }

  private async invoke<T>(functionName: string, payload: unknown): Promise<T> {
    const response = await this.lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    )
    const text = response.Payload ? new TextDecoder().decode(response.Payload) : ''
    if (response.FunctionError) {
      throw new ServiceError(`${functionName} failed (${response.FunctionError}): ${text.slice(0, 500)}`)
    }
    let parsed: ApiResponse<T>
    try {
      parsed = JSON.parse(text) as ApiResponse<T>
    } catch {
      throw new ServiceError(`${functionName} returned a non-JSON payload`)
    }
    if (!parsed.ok) {
      const issues = parsed.error.issues?.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')
      throw new ServiceError(`${parsed.error.code}: ${parsed.error.message}${issues ? ` (${issues})` : ''}`, parsed.error)
    }
    return parsed.value
  }
}
