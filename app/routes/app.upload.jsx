import {
  json,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const contentType = request.headers.get("content-type");

  if (request.method === "POST" && contentType?.includes("multipart/form-data")) {
    // Handle upload
    const uploadHandler = unstable_createMemoryUploadHandler({
      maxPartSize: 10_000_000,
    });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);

    const file = formData.get("file");
    if (!file || typeof file !== "object") {
      return json({ success: false, error: "No file uploaded" }, { status: 400 });
    }

    const { admin } = await authenticate.admin(request);

    const stagedUploadRes = await admin.graphql(`
      mutation generateStagedUploadTarget {
        stagedUploadsCreate(input: [
          {
            filename: "${file.name}",
            mimeType: "${file.type}",
            resource: FILE,
            httpMethod: POST
          }
        ]) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    const stagedUploadData = await stagedUploadRes.json();
    const target = stagedUploadData.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      return json({ success: false, error: "Failed to get staged upload target" }, { status: 500 });
    }

    const formUpload = new FormData();
    for (const param of target.parameters) {
      formUpload.append(param.name, param.value);
    }
    formUpload.append("file", file);

    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: formUpload,
    });

    if (!uploadResponse.ok) {
      return json({ success: false, error: "Failed to upload to Shopify storage" }, { status: 500 });
    }

    const fileCreateRes = await admin.graphql(`
      mutation fileCreate {
        fileCreate(files: [{
          originalSource: "${target.resourceUrl}",
          contentType: IMAGE,
          alt: "${file.name}"
        }]) {
          files {
            ... on MediaImage {
              id
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `);

    const fileCreateData = await fileCreateRes.json();
    const createdFile = fileCreateData.data?.fileCreate?.files?.[0];

    if (!createdFile) {
      return json({ success: false, error: "Failed to save file in Shopify" }, { status: 500 });
    }

    return json({ success: true, file: createdFile });
  }

  // Handle DELETE (non-multipart)
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "deleteFile") {
    const fileId = formData.get("fileId");
    if (!fileId) {
      return json({ success: false, error: "Missing file ID" }, { status: 400 });
    }

    const { admin } = await authenticate.admin(request);

    const deleteRes = await admin.graphql(`
      mutation {
        fileDelete(fileIds: ["${fileId}"]) {
          deletedFileIds
          userErrors {
            field
            message
          }
        }
      }
    `);

    const deleteData = await deleteRes.json();
    const deleted = deleteData.data?.fileDelete?.deletedFileIds?.[0];

    if (!deleted) {
      return json({ success: false, error: "Failed to delete file" }, { status: 500 });
    }

    return json({ success: true });
  }

  return json({ success: false, error: "Unknown intent" }, { status: 400 });
};
