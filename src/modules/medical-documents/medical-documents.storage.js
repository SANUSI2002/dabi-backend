import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRIVATE_BUCKETS } from "../../config/privateStorage.js";

export const DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
];

// Both providers speak the S3 protocol. Supabase Storage additionally requires
// path-style addressing and uses the private bucket the API already verifies at startup.
const PROVIDERS = {
  r2: {
    required: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"],
    read: (env) => ({
      bucket: env.R2_BUCKET,
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      forcePathStyle: false,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    }),
  },
  supabase: {
    required: ["SUPABASE_S3_ENDPOINT", "SUPABASE_S3_REGION", "SUPABASE_S3_ACCESS_KEY_ID", "SUPABASE_S3_SECRET_ACCESS_KEY"],
    read: (env) => ({
      bucket: PRIVATE_BUCKETS.clinicalDocuments,
      endpoint: env.SUPABASE_S3_ENDPOINT,
      region: env.SUPABASE_S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: env.SUPABASE_S3_ACCESS_KEY_ID, secretAccessKey: env.SUPABASE_S3_SECRET_ACCESS_KEY },
    }),
  },
};

export class StorageUnavailableError extends Error {
  constructor() {
    super("Document storage is unavailable");
    this.code = "DOCUMENT_STORAGE_UNAVAILABLE";
  }
}

export const readConfig = (env = process.env) => {
  const provider = PROVIDERS[env.DOCUMENT_STORAGE_PROVIDER];
  if (!provider || provider.required.some((key) => !env[key]?.trim())) {
    throw new StorageUnavailableError();
  }
  const ttl = Number(env.DOCUMENT_SIGNED_URL_TTL_SECONDS || 300);
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900)
    throw new StorageUnavailableError();
  return { ...provider.read(env), ttl };
};

export const getUploadMaxBytes = () => {
  const value = Number(
    process.env.DOCUMENT_UPLOAD_MAX_BYTES || 10 * 1024 * 1024,
  );
  return Number.isInteger(value) && value > 0 && value <= 50 * 1024 * 1024
    ? value
    : 10 * 1024 * 1024;
};

export class R2DocumentStorage {
  constructor() {
    const config = readConfig();
    this.bucket = config.bucket;
    this.ttl = config.ttl;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: config.credentials,
    });
  }

  async createUpload({ objectKey, contentType, byteSize }) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: byteSize,
    });
    return {
      method: "PUT",
      url: await getSignedUrl(this.client, command, { expiresIn: this.ttl }),
      expiresInSeconds: this.ttl,
      headers: { "Content-Type": contentType },
    };
  }

  async head(objectKey) {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    return { byteSize: result.ContentLength, contentType: result.ContentType };
  }

  async createDownload(objectKey) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: this.ttl }),
      expiresInSeconds: this.ttl,
    };
  }

  async delete(objectKey) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }
}

export const createDocumentStorage = () => new R2DocumentStorage();
