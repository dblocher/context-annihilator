import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { PayloadStore } from '../../domain/jobs/ports.js'

/** Complete input and output payloads. The bucket expires objects through a lifecycle rule. */
export class S3PayloadStore implements PayloadStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, JSON.stringify(value), 'application/json')
  }

  async getJson<T>(key: string): Promise<T> {
    return JSON.parse(await this.getText(key)) as T
  }

  async putText(key: string, text: string): Promise<void> {
    await this.put(key, text, 'text/plain; charset=utf-8')
  }

  async getText(key: string): Promise<string> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!response.Body) throw new Error(`empty S3 object body for key ${key}`)
    return response.Body.transformToString('utf-8')
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds })
  }

  private async put(key: string, body: string, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }))
  }
}
