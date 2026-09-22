import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { gql } from "../lib/shop.server";

/**
 * POST /app/upload — an image for a deal bar, stored in Shopify Files.
 *
 * The editor sends the file here (App Bridge adds the session token to
 * same-origin fetches); the server does the staged upload, creates the file
 * and waits until Shopify has processed it, then returns its CDN URL.
 * Needs the write_files scope.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type Result = { ok: true; url: string; alt: string } | { ok: false; error: string };

const fail = (error: string): Result => ({ ok: false, error });

export const action = async ({ request }: ActionFunctionArgs): Promise<Result> => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const file = form.get("file");
  const alt = String(form.get("alt") ?? "").slice(0, 200);
  if (!(file instanceof File)) return fail("Choose an image to upload.");
  if (!TYPES.includes(file.type)) return fail("Use a PNG, JPG, WebP or GIF image.");
  if (file.size > MAX_BYTES) return fail("The image must be 5 MB or smaller.");

  try {
    // 1. Where to upload.
    const staged = await gql<{
      stagedUploadsCreate: {
        stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
        userErrors: { message: string }[];
      };
    }>(
      admin,
      `#graphql
        mutation cartliftStagedUpload($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { message }
          }
        }`,
      {
        input: [
          { resource: "IMAGE", filename: file.name || "bar-image", mimeType: file.type, fileSize: String(file.size), httpMethod: "POST" },
        ],
      },
    );
    const target = staged.stagedUploadsCreate.stagedTargets[0];
    if (!target) return fail(staged.stagedUploadsCreate.userErrors[0]?.message || "Upload failed.");

    // 2. Upload the bytes.
    const body = new FormData();
    for (const p of target.parameters) body.append(p.name, p.value);
    body.append("file", file);
    const upload = await fetch(target.url, { method: "POST", body });
    if (!upload.ok) return fail("Upload failed. Try again.");

    // 3. Create the file and wait for Shopify to process it.
    const created = await gql<{
      fileCreate: { files: { id: string }[]; userErrors: { message: string }[] };
    }>(
      admin,
      `#graphql
        mutation cartliftFileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) { files { id } userErrors { message } }
        }`,
      { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt }] },
    );
    const id = created.fileCreate.files[0]?.id;
    if (!id) return fail(created.fileCreate.userErrors[0]?.message || "Upload failed.");

    for (let attempt = 0; attempt < 12; attempt++) {
      const node = await gql<{ node: { fileStatus: string; image: { url: string } | null } | null }>(
        admin,
        `#graphql
          query cartliftFile($id: ID!) {
            node(id: $id) { ... on MediaImage { fileStatus image { url } } }
          }`,
        { id },
      );
      if (node.node?.fileStatus === "FAILED") return fail("Shopify couldn't process this image.");
      if (node.node?.image?.url) return { ok: true, url: node.node.image.url, alt };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return fail("The image is still processing. Try again in a moment.");
  } catch (error) {
    console.error("Bar image upload failed", error);
    const message = String(error);
    if (/access|scope|denied/i.test(message)) {
      return fail("CartLift needs permission to upload files. Approve the updated permissions and try again.");
    }
    return fail("Upload failed. Try again.");
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
