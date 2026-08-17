import { describe, expect, it } from "vitest";
import {
  createFileAttachmentMessageHook,
  createFileAttachmentMetadata,
  parseFileAttachmentMetadata,
} from "../src/index";
import type { FilepackApi, FilepackFile, FilepackRouter } from "@filepack/core";

const file: FilepackFile = {
  id: "file-1",
  route: "chat",
  name: "photo.png",
  contentType: "image/png",
  size: 12,
  routeMetadata: { conversationId: "conversation-1" },
  createdAt: "2026-08-04T00:00:00.000Z",
  readyAt: "2026-08-04T00:00:01.000Z",
};

function filepackFor(value: FilepackFile = file): FilepackApi<FilepackRouter> {
  return {
    getFile: async () => value,
  } as unknown as FilepackApi<FilepackRouter>;
}

describe("Filepack message metadata", () => {
  it("stores stable file fields only", () => {
    const metadata = createFileAttachmentMetadata([file]);
    expect(metadata).toEqual({
      filepack: {
        version: 1,
        attachments: [{ id: "file-1", name: "photo.png", contentType: "image/png", size: 12 }],
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("objectKey");
    expect(JSON.stringify(metadata)).not.toContain("url");
  });

  it("rejects provider fields in attachment metadata", () => {
    expect(() =>
      parseFileAttachmentMetadata({
        filepack: {
          version: 1,
          attachments: [{ ...file, url: "https://signed.invalid" }],
        },
      }),
    ).toThrow("Invalid Filepack attachment metadata.");
  });

  it("rejects duplicate file references", () => {
    expect(() =>
      parseFileAttachmentMetadata({
        filepack: {
          version: 1,
          attachments: [
            { id: "file-1", name: "photo.png", contentType: "image/png", size: 12 },
            { id: "file-1", name: "photo.png", contentType: "image/png", size: 12 },
          ],
        },
      }),
    ).toThrow("Invalid Filepack attachment metadata.");
  });

  it("validates the ready record and conversation before message persistence", async () => {
    const authorized: string[] = [];
    const hook = createFileAttachmentMessageHook({
      filepack: filepackFor(),
      authorizeUpload: () => true,
      authorizeAttachment: ({ file: authorizedFile }) => {
        authorized.push(authorizedFile.id);
        return true;
      },
    });
    const result = await hook({
      user: { id: "alice" },
      conversation: {
        id: "conversation-1",
        type: "direct",
        name: null,
        visibility: "private",
        joinPolicy: "approval",
        pairKey: "alice:bob",
        createdAt: new Date(),
        metadata: {},
        participants: [],
        participantIds: ["alice", "bob"],
      },
      body: "photo",
      metadata: createFileAttachmentMetadata([file]),
      role: "user",
      action: "send",
      mentions: [],
      forwardedFrom: null,
    });

    expect(authorized).toEqual(["file-1"]);
    expect(result?.metadata?.filepack).toEqual(createFileAttachmentMetadata([file]).filepack);
  });

  it("rejects a file associated with another conversation", async () => {
    const hook = createFileAttachmentMessageHook({
      filepack: filepackFor({ ...file, routeMetadata: { conversationId: "conversation-2" } }),
      authorizeUpload: () => true,
    });
    await expect(
      hook({
        user: { id: "alice" },
        conversation: {
          id: "conversation-1",
          type: "direct",
          name: null,
          visibility: "private",
          joinPolicy: "approval",
          pairKey: "alice:bob",
          createdAt: new Date(),
          metadata: {},
          participants: [],
          participantIds: ["alice", "bob"],
        },
        body: "photo",
        metadata: createFileAttachmentMetadata([file]),
        role: "user",
        action: "send",
        mentions: [],
        forwardedFrom: null,
      }),
    ).rejects.toThrow("unavailable");
  });
});
