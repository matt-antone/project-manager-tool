import React from "react";
import { type ReactNode, type RefObject } from "react";
import { OneShotButton } from "@/components/one-shot-button";

type CreateDiscussionDialogProps = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  title: string;
  bodyMarkdown: string;
  editor: ReactNode;
  attachmentsSlot?: ReactNode;
  canSubmit?: boolean;
  submitLabel?: string;
  onTitleChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
};

export function CreateDiscussionDialog(props: CreateDiscussionDialogProps) {
  const {
    dialogRef,
    title,
    bodyMarkdown,
    editor,
    attachmentsSlot,
    canSubmit,
    submitLabel,
    onTitleChange,
    onCreate,
    onCancel
  } = props;
  const submitDisabled = canSubmit !== undefined ? !canSubmit : !title || !bodyMarkdown;
  return (
    <dialog ref={dialogRef} className="dialog dialogCreateDiscussion">
      <form method="dialog" className="dialogForm">
        <h3>Create Discussion</h3>
        <div className="form">
          <div className="withAside">
            <div>
              <input value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder="Discussion title" />
              {editor}
            </div>
            <div>
              {attachmentsSlot}
            </div>
          </div>
        </div>
        <div className="row">
          <OneShotButton type="button" onClick={onCreate} disabled={submitDisabled}>
            {submitLabel ?? "Create"}
          </OneShotButton>
          <OneShotButton type="button" className="secondary" onClick={onCancel}>
            Cancel
          </OneShotButton>
        </div>
      </form>
    </dialog>
  );
}
