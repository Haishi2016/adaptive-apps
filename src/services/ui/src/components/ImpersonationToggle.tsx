import { Field, Radio, RadioGroup, Text } from '@fluentui/react-components';
import type { ImpersonationMode } from '../api/client';

const REQUESTED_CALLER: Record<ImpersonationMode, string> = {
  app: 'Requests the agent’s own app identity (no user).',
  endUserOBO: 'Requests the signed-in user identity through on-behalf-of (OBO).',
  agentUser: 'Requests the agent’s worker identity; an Entra worker user must be provisioned separately. A Keycloak mirror does not confirm Entra setup.',
};

const OPTIONS: Array<{ value: ImpersonationMode; label: string }> = [
  { value: 'app', label: 'App' },
  { value: 'endUserOBO', label: 'On behalf of me' },
  { value: 'agentUser', label: 'Agent user' },
];

export interface ImpersonationToggleProps {
  value: ImpersonationMode;
  onChange: (mode: ImpersonationMode) => void;
  allowedModes?: readonly ImpersonationMode[];
  disabled?: boolean;
}

export function ImpersonationToggle({
  value,
  onChange,
  allowedModes,
  disabled = false,
}: ImpersonationToggleProps): JSX.Element {
  return (
    <Field label="Call identity" hint="Requested caller identity. Tool authentication and downstream execution identity can differ.">
      <RadioGroup
        layout="horizontal"
        value={value}
        disabled={disabled}
        onChange={(_, data) => onChange(data.value as ImpersonationMode)}
      >
        {OPTIONS.map((option) => (
          <Radio key={option.value} value={option.value} label={option.label}
            disabled={disabled || !(allowedModes ?? ['app']).includes(option.value)} />
        ))}
      </RadioGroup>
      <Text size={200} className="muted-text" role="note">
        {REQUESTED_CALLER[value]}
      </Text>
      <Text size={200} className="muted-text">
        OBO requires connected mode, configured Graph delegation and an administrator-linked Entra user.
        Agent user requires a provisioned Entra worker user. Hosted delegation is unavailable.
      </Text>
    </Field>
  );
}
