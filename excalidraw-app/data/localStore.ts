import { reconcileElements } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { getSceneVersion } from "@excalidraw/excalidraw/element";
import type Portal from "../collab/Portal";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";
import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { MIME_TYPES } from "@excalidraw/excalidraw/constants";
import type { SyncableExcalidrawElement } from ".";
import { getSyncableElements } from ".";
import type { Socket } from "socket.io-client";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";

// Scenes and room files are stored by the app's own server, under the path
// the app itself is served from. Nothing in this module talks to a third
// party, and no endpoint is configurable: the only reachable origin is the
// one the page was loaded from.
//
// Rooms and files are end-to-end encrypted with the room key, which lives in
// the URL fragment and is never sent to the server.
const storeUrl = (path: string) => {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
};

const roomScenePath = (roomId: string) => `files/rooms/${roomId}/scene`;

type StoredScene = {
  iv: Uint8Array;
  ciphertext: Uint8Array;
};

const encodeStoredScene = ({ iv, ciphertext }: StoredScene): Uint8Array => {
  const buffer = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  buffer.set(iv, 0);
  buffer.set(ciphertext, iv.byteLength);
  return buffer;
};

const decodeStoredScene = (buffer: Uint8Array): StoredScene => ({
  iv: buffer.slice(0, IV_LENGTH_BYTES),
  ciphertext: buffer.slice(IV_LENGTH_BYTES),
});

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<StoredScene> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { iv, ciphertext: new Uint8Array(encryptedBuffer) };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(data.iv, data.ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return SceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToLocalStore = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToLocalStore = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(storeUrl(`${prefix}/${id}`), {
          method: "POST",
          headers: {
            "Content-Type": MIME_TYPES.binary,
            "Cache-Control": `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
          },
          body: buffer,
        });
        if (!response.ok) {
          throw new Error(`failed to save file ${id}: ${response.status}`);
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const loadStoredScene = async (roomId: string): Promise<StoredScene | null> => {
  const response = await fetch(storeUrl(roomScenePath(roomId)));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`failed to load room ${roomId}: ${response.status}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength <= IV_LENGTH_BYTES) {
    return null;
  }
  return decodeStoredScene(buffer);
};

const putStoredScene = async (roomId: string, scene: StoredScene) => {
  const response = await fetch(storeUrl(roomScenePath(roomId)), {
    method: "POST",
    headers: { "Content-Type": MIME_TYPES.binary },
    body: encodeStoredScene(scene),
  });
  if (!response.ok) {
    throw new Error(`failed to save room ${roomId}: ${response.status}`);
  }
};

export const saveToLocalStore = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToLocalStore(portal, elements)
  ) {
    return null;
  }

  // Read-modify-write against the app's own store. There is no transaction:
  // a room is a single owner's board, and live edits are already reconciled
  // over the socket, so the last writer wins on the stored copy.
  const prevStoredScene = await loadStoredScene(roomId);

  let elementsToStore = elements;
  if (prevStoredScene) {
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    elementsToStore = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );
  }

  const storedScene = await encryptElements(roomKey, elementsToStore);
  await putStoredScene(roomId, storedScene);

  // Return the stored elements as the in memory `elementsToStore` could have
  // mutated in the meantime
  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  SceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromLocalStore = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const storedScene = await loadStoredScene(roomId);
  if (!storedScene) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  if (socket) {
    SceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromLocalStore = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(storeUrl(`${prefix}/${id}`));
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
