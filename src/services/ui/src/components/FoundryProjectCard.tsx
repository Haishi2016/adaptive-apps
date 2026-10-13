import { Badge, Spinner, Text, Tooltip } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { getEnvironment } from '../api/client';

function projectLabel(value: string): string {
  const match = value.match(/\/projects\/([^/?#]+)/i);
  return match?.[1] ?? value;
}

export function FoundryProjectCard(): JSX.Element {
  const query = useQuery({
    queryKey: ['environment'],
    queryFn: getEnvironment,
  });
  const project = query.data;
  const endpoint = project?.cloud.foundryProjectEndpoint;

  return (
    <div className="sidebar-foundry-card" aria-label="Connected Foundry project">
      <Text size={200} className="muted-text" weight="semibold">Connected Foundry project</Text>
      {query.isLoading ? <Spinner size="extra-tiny" label="Loading project" /> : null}
      {query.error ? <Text className="error-text">Environment unavailable</Text> : null}
      {project && !query.error ? (
        <Tooltip content={endpoint ?? 'No cloud project configured'} relationship="description">
          <div className="sidebar-foundry-status-row">
            <Text weight="semibold">
              {project.cloud.enabled
                ? projectLabel(project.cloud.foundryProjectArmId ?? endpoint ?? 'Cloud project')
                : 'No cloud project'}
            </Text>
            <Badge color={project.cloud.enabled ? 'brand' : 'warning'} appearance="tint">
              {project.cloud.enabled ? 'Cloud' : 'Edge-only'}
            </Badge>
          </div>
        </Tooltip>
      ) : null}
    </div>
  );
}
