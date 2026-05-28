"use client";

import { OneShotButton } from "@/components/one-shot-button";

type ProjectDialogClient = {
  id: string;
  name: string;
  code: string;
};

export type ProjectDialogValues = {
  name: string;
  description: string;
  deadline: string;
  requestor: string;
  tags: string;
  clientId: string;
  /** PM note; only shown on project detail edit, not create dialog. */
  pm_note: string;
};

type ProjectDialogMember = {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

export type ProjectDialogActiveUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

type ProjectDialogFormProps = {
  title: string;
  submitLabel: string;
  values: ProjectDialogValues;
  clients: ProjectDialogClient[];
  submitting?: boolean;
  clientDisabled?: boolean;
  /** When true, show PM note (detail edit only). */
  showPmNote?: boolean;
  members?: ProjectDialogMember[];
  activeUsers?: ProjectDialogActiveUser[];
  /** When set, renders this user's row as checked + disabled (creator lock). */
  currentUserId?: string;
  onAddMember?: (userId: string) => void;
  onRemoveMember?: (userId: string) => void;
  onChange: (values: ProjectDialogValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function ProjectDialogForm({
  title,
  submitLabel,
  values,
  clients,
  submitting = false,
  clientDisabled = false,
  showPmNote = false,
  members,
  activeUsers,
  currentUserId,
  onAddMember,
  onRemoveMember,
  onChange,
  onSubmit,
  onCancel
}: ProjectDialogFormProps) {
  function updateField<K extends keyof ProjectDialogValues>(field: K, value: ProjectDialogValues[K]) {
    onChange({
      ...values,
      [field]: value
    });
  }

  const canSubmit = values.name.trim().length > 0 && values.clientId.length > 0 && !submitting;
  const showMembers = Boolean(members && activeUsers && onAddMember && onRemoveMember);

  return (
    <form method="dialog" className="dialogForm">
      <h3>{title}</h3>
      <div className="form">
        <label className="dialogField">
          <span>Name</span>
          <input
            value={values.name}
            onChange={(event) => updateField("name", event.target.value)}
            placeholder="Project name"
          />
        </label>
        <label className="dialogField">
          <span>Description</span>
          <input
            value={values.description}
            onChange={(event) => updateField("description", event.target.value)}
            placeholder="Description"
          />
        </label>
        <label className="dialogField">
          <span>Deadline</span>
          <input
            type="date"
            value={values.deadline}
            onChange={(event) => updateField("deadline", event.target.value)}
          />
        </label>
        <label className="dialogField">
          <span>Requester</span>
          <input
            value={values.requestor}
            onChange={(event) => updateField("requestor", event.target.value)}
            placeholder="Who requested this work?"
          />
        </label>
        <label className="dialogField">
          <span>Tags</span>
          <input
            value={values.tags}
            onChange={(event) => updateField("tags", event.target.value)}
            placeholder="Tags (comma separated)"
          />
        </label>
        {showPmNote ? (
          <label className="dialogField">
            <span>PM note</span>
            <textarea
              value={values.pm_note}
              maxLength={256}
              rows={3}
              onChange={(event) => updateField("pm_note", event.target.value)}
              placeholder="Short note for the team (shown on list and board)"
            />
            <span className="dialogFieldHint">{(values.pm_note ?? "").length}/256</span>
          </label>
        ) : null}
        <label className="dialogField">
          <span>Client</span>
          <select
            value={values.clientId}
            onChange={(event) => updateField("clientId", event.target.value)}
            disabled={clientDisabled}
          >
            <option value="">Select client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.code} - {client.name}
              </option>
            ))}
          </select>
        </label>
        {clientDisabled ? <p className="dialogFieldHint">Client stays fixed after a project is created.</p> : null}
        {showMembers ? (
          <fieldset className="dialogField">
            <legend>Members</legend>
            <ul className="memberCheckboxList">
              {activeUsers!.map((u) => {
                const isSelf = currentUserId !== undefined && u.id === currentUserId;
                const isMember = members!.some((m) => m.user_id === u.id);
                const isLastMember = isMember && members!.length <= 1;
                const displayName = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
                if (isSelf) {
                  return (
                    <li key={u.id} className="memberCheckboxItem">
                      <label>
                        <input type="checkbox" checked disabled onChange={() => {}} />
                        <span className="memberCheckboxName">{displayName} (you)</span>
                      </label>
                      <small className="memberCheckboxHint">Project creator is always a member</small>
                    </li>
                  );
                }
                return (
                  <li key={u.id} className="memberCheckboxItem">
                    <label>
                      <input
                        type="checkbox"
                        checked={isMember}
                        disabled={isLastMember}
                        onChange={(event) => {
                          if (event.target.checked) onAddMember!(u.id);
                          else onRemoveMember!(u.id);
                        }}
                      />
                      <span className="memberCheckboxName">{displayName}</span>
                    </label>
                    {isLastMember ? <small className="memberCheckboxHint">Cannot remove the last member</small> : null}
                  </li>
                );
              })}
              {activeUsers!.length === 0 ? <li><small>No active users available.</small></li> : null}
            </ul>
          </fieldset>
        ) : null}
      </div>
      <div className="row">
        <OneShotButton type="button" onClick={onSubmit} disabled={!canSubmit}>
          {submitting ? "Saving..." : submitLabel}
        </OneShotButton>
        <OneShotButton type="button" className="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </OneShotButton>
      </div>
    </form>
  );
}
