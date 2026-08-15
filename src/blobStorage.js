import { BlobServiceClient } from '@azure/storage-blob'

const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'images'
let containerClient

function getContainerClient() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (!connectionString) {
    throw new Error('Missing required environment variable: AZURE_STORAGE_CONNECTION_STRING')
  }
  if (!connectionString.includes('AccountName=') || !connectionString.includes('AccountKey=')) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING must be the complete Azure connection string from Storage Account > Access keys, not the access key alone')
  }
  if (!containerClient) {
    containerClient = BlobServiceClient
      .fromConnectionString(connectionString)
      .getContainerClient(containerName)
  }
  return containerClient
}

export async function ensureBlobContainer() {
  await getContainerClient().createIfNotExists()
}

export async function uploadBlob(blobName, data, contentType) {
  const blobClient = getContainerClient().getBlockBlobClient(blobName)
  await blobClient.uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' },
  })
  return blobName
}

export async function downloadBlob(blobName) {
  return getContainerClient().getBlobClient(blobName).download()
}
