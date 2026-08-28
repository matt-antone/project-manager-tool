import React from "react";
import { type RefObject } from "react";
import { ThumbnailPreview } from "@/components/file-thumbnail-preview";
import { OneShotButton } from "@/components/one-shot-button";
import { formatBytes } from "@/lib/format-bytes";

type ProjectFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  thumbnail_url?: string | null;
  created_at: string;
};

type ProjectFilesPanelProps = {
  projectId: string;
  token: string | null;
  onToken: (value: string | null) => void;
  files: ProjectFile[];
  selectedFile: File | null;
  isUploading: boolean;
  isFileDragActive: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileInputSelection: (files: FileList | null) => void;
  onSetFileDragActive: (next: boolean) => void;
  onOpenProjectFolder: () => void;
  onUploadSelectedFile: () => void;
  onClearSelectedFile: () => void;
  onDownloadFile: (fileId: string) => void | Promise<void>;
  getFileBadgeLabel: (file: ProjectFile) => string;
  newFileIds?: ReadonlySet<string>;
};

export function ProjectFilesPanel(props: ProjectFilesPanelProps) {
  const {
    projectId,
    token,
    onToken,
    files,
    selectedFile,
    isUploading,
    isFileDragActive,
    fileInputRef,
    onFileInputSelection,
    onSetFileDragActive,
    onOpenProjectFolder,
    onUploadSelectedFile,
    onClearSelectedFile,
    onDownloadFile,
    getFileBadgeLabel,
    newFileIds = new Set<string>()
  } = props;

  return (
    <section className="stackSection filesSection">
      <div className="sectionHeader">
        <div className="sectionHeaderTitle">
          <h2>Files</h2>
          <OneShotButton type="button" className="filesFolderLink linkButton" onClick={onOpenProjectFolder}>
            Open Dropbox folder
          </OneShotButton>
        </div>
        <div className="sectionHeaderTitle">
          {files.length > 0 && (
            <OneShotButton
              type="button"
              className="linkButton"
              onClick={async () => {
                for (const file of files) await onDownloadFile(file.id);
              }}
            >
              Download all
            </OneShotButton>
          )}
          <small className="filesCount">{files.length} total</small>
        </div>
      </div>

      <ul className="fileThumbGrid">
        <li className="fileThumbItem fileThumbUploadItem">
          <div className="commentUploadArea fileUploadArea fileThumbUploadArea">
            <input
              ref={fileInputRef}
              type="file"
              className="commentFileInputHidden"
              onChange={(event) => onFileInputSelection(event.target.files)}
            />
            {!selectedFile && (
              <div
                className={`commentDropZone fileThumbUploadDropZone ${isFileDragActive ? "commentDropZoneActive" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  onSetFileDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  onSetFileDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  onSetFileDragActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  onSetFileDragActive(false);
                  onFileInputSelection(event.dataTransfer.files);
                }}
              >
                <p className="commentDropZoneTitle">Drop a file here</p>
                <p className="commentDropZoneSubtle">or click to browse</p>
              </div>
            )}
            <div className="commentUploadQueueShell">
              {selectedFile && (
                <ul className="commentUploadQueue">
                  <li className="commentUploadQueueItem">
                    <div className="commentUploadQueueHead">
                      <span>{selectedFile.name}</span>
                      <small>{formatBytes(selectedFile.size)} • ready to upload</small>
                    </div>
                    {!isUploading && (
                      <div className="commentUploadQueueItemButton">
                        <OneShotButton
                          type="button"
                          className="linkButton"
                          onClick={(event) => {
                            event.stopPropagation();
                            onClearSelectedFile();
                          }}
                        >
                          Remove
                        </OneShotButton>
                      </div>
                    )}
                  </li>
                </ul>
              )}
              <OneShotButton type="button" onClick={onUploadSelectedFile} disabled={!selectedFile || isUploading}>
                {isUploading ? "Uploading..." : "Upload File"}
              </OneShotButton>
            </div>
          </div>
        </li>
        {files.map((file) => {
          return (
            <li key={file.id} className="fileThumbItem">
              <OneShotButton
                type="button"
                className="fileThumbHitArea"
                onClick={() => onDownloadFile(file.id)}
              >
                <ThumbnailPreview
                  projectId={projectId}
                  fileId={file.id}
                  filename={file.filename}
                  mimeType={file.mime_type}
                  thumbnailUrl={file.thumbnail_url}
                  accessToken={token}
                  onToken={onToken}
                  alt={file.filename}
                  imageClassName="fileThumbImage"
                  fallback={<div className="fileThumbFallback">{getFileBadgeLabel(file)}</div>}
                />
              </OneShotButton>
              <div className="fileThumbMeta">
                <div className="fileThumbNameRow">
                  <OneShotButton
                    type="button"
                    className="fileDownloadButton"
                    onClick={() => onDownloadFile(file.id)}
                    title={file.filename}
                  >
                    {file.filename}
                  </OneShotButton>
                  {newFileIds.has(file.id) ? <span className="newItemPill">New</span> : null}
                </div>
                <small>
                  {formatBytes(file.size_bytes)} •{" "}
                  {new Date(file.created_at).toLocaleDateString()}
                </small>
              </div>
            </li>
          );
        })}
        {files.length === 0 && (
          <li className="emptyProjectsText fileThumbEmptyState">No files yet. Upload one to start your project workspace.</li>
        )}
      </ul>
    </section>
  );
}
