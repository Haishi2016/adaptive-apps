import {
  Badge,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  Spinner,
  TableColumnDefinition,
  Text,
  createTableColumn,
} from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Agent, listAgents, listAgentVersions } from '../../api/client';

function ReleaseInventory({ name }: { name: string }): JSX.Element {
  const query = useQuery({ queryKey: ['agent-versions', name], queryFn: () => listAgentVersions(name), refetchInterval: 10_000 });
  if (query.isLoading) return <Text>Loading releases…</Text>;
  if (query.error) return <Text>Release inventory unavailable</Text>;
  return <Text>{query.data?.map((release) => `${release.version} · ${release.status}`).join(', ') || 'No captured releases'}</Text>;
}

const columns: TableColumnDefinition<Agent>[] = [
  createTableColumn<Agent>({
    columnId: 'name',
    renderHeaderCell: () => 'Name',
    renderCell: (agent) => <Text weight="semibold">{agent.name}</Text>,
  }),
  createTableColumn<Agent>({
    columnId: 'version',
    renderHeaderCell: () => 'Releases',
    renderCell: (agent) => <ReleaseInventory name={agent.name} />,
  }),
  createTableColumn<Agent>({
    columnId: 'requested',
    renderHeaderCell: () => 'Requested active',
    renderCell: (agent) => agent.requestedActiveVersion ?? '—',
  }),
  createTableColumn<Agent>({
    columnId: 'effective',
    renderHeaderCell: () => 'Effective active',
    renderCell: (agent) => agent.activeVersion ?? '—',
  }),
  createTableColumn<Agent>({
    columnId: 'readiness',
    renderHeaderCell: () => 'Active readiness',
    renderCell: (agent) => agent.phase ?? 'Unknown',
  }),
  createTableColumn<Agent>({
    columnId: 'type',
    renderHeaderCell: () => 'Type',
    renderCell: (agent) => (
      <Badge appearance="filled" color={agent.type === 'prompt' ? 'brand' : 'important'}>
        {agent.type}
      </Badge>
    ),
  }),
  createTableColumn<Agent>({
    columnId: 'created',
    renderHeaderCell: () => 'Created',
    renderCell: (agent) => agent.created != null
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(agent.created * 1000))
      : '—',
  }),
  createTableColumn<Agent>({
    columnId: 'description',
    renderHeaderCell: () => 'Description',
    renderCell: (agent) => agent.description ?? '—',
  }),
];

export function AgentsList(): JSX.Element {
  const navigate = useNavigate();
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: listAgents, refetchInterval: 10_000 });
  const agents = agentsQuery.data ?? [];

  return (
    <section className="page agents-list-page">
      <div className="page-heading">
        <div className="page-heading-text">
          <Text as="h1" size={600} weight="semibold">Agents</Text>
          <Text className="muted-text">View and call agents here. Manage deployments through Radius.</Text>
        </div>
      </div>
      {agentsQuery.isLoading ? <Spinner label="Loading agents" /> : null}
      {agentsQuery.error ? <div className="error-text">Failed to load agents.</div> : null}
      <Text size={200} className="muted-text">
        Active readiness is qualified from native workload, state and ingress conditions.
        An Available release does not declare promotion. — means the API did not report a value.
      </Text>
      <DataGrid items={agents} columns={columns} getRowId={(item) => item.name} className="foundry-grid">
        <DataGridHeader>
          <DataGridRow>
            {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<Agent>>
          {({ item, rowId }) => (
            <DataGridRow<Agent>
              key={rowId}
              onClick={() => navigate(`/agents/${encodeURIComponent(item.name)}/${item.type}`)}
              className="clickable-row"
            >
              {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>
      <Text className="muted-text">{agents.length} agent{agents.length === 1 ? '' : 's'}</Text>
    </section>
  );
}
