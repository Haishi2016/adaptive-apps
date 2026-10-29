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
import { ToolCatalogEntry, listTools } from '../../api/client';
import { useConnectivityFaultStore } from '../../state/connectivityFault';
import { authTypeLabel, executionIdentityLabel, identityModeLabels } from './toolCatalog';

const columns: TableColumnDefinition<ToolCatalogEntry>[] = [
  createTableColumn<ToolCatalogEntry>({
    columnId: 'name',
    renderHeaderCell: () => 'Name',
    renderCell: (tool) => (
      <div>
        <Text weight="semibold">{tool.displayName}</Text>
        <div><code>{tool.name}</code></div>
        <Text size={200}>{tool.description}</Text>
      </div>
    ),
  }),
  createTableColumn<ToolCatalogEntry>({
    columnId: 'kind',
    renderHeaderCell: () => 'Kind',
    renderCell: (tool) => <Badge appearance="filled" color="brand">{tool.kind === 'skills' ? 'Skills' : tool.kind === 'builtin' ? 'Built-in' : 'MCP'}</Badge>,
  }),
  createTableColumn<ToolCatalogEntry>({
    columnId: 'authType',
    renderHeaderCell: () => 'Authentication and scope',
    renderCell: (tool) => tool.kind === 'skills' ? (
      <Text>No authentication. Deployment-supplied instruction files.</Text>
    ) : (
      <div>
        <Text>{authTypeLabel(tool.authType)}</Text>
        {tool.authType === 'entra' ? (
          <>
            <div>Audience: {tool.audience ?? 'Not configured'}</div>
            <div>{tool.identityModes.map((mode) => identityModeLabels[mode]).join(', ') || 'No supported identity modes'}</div>
            <Text size={200}>Cloud-only; unavailable in red-button mode.</Text>
          </>
        ) : <div>No platform identity bearer is sent.</div>}
      </div>
    ),
  }),
  createTableColumn<ToolCatalogEntry>({
    columnId: 'executionIdentity',
    renderHeaderCell: () => 'Execution identity',
    renderCell: (tool) => tool.kind === 'skills'
      ? 'Native on-demand instructions; no scripts or additional privileges.'
      : executionIdentityLabel(tool.executionIdentity, tool.kind === 'builtin'),
  }),
];

export function ToolsList(): JSX.Element {
  const query = useQuery({ queryKey: ['tools'], queryFn: listTools });
  const mode = useConnectivityFaultStore((state) => state.enabled);
  const tools = query.data ?? [];
  return (
    <section className="page tools-list-page">
      <div className="page-heading">
        <div className="page-heading-text">
          <Text as="h1" size={600} weight="semibold">Tools</Text>
          <Text className="muted-text">Read-only platform tools. Administrators manage MCP profiles through Radius chartValues.toolCatalog and native built-ins through Radius agentTools; Skills is built in.</Text>
        </div>
      </div>
      {query.isLoading ? <Spinner label="Loading tools" /> : null}
      {query.error ? <div className="error-text">Failed to load tools.</div> : null}
      <Text>
        The built-in <code>graph-me</code> binding selects native <code>graph_me</code> in prompt releases,
        with no MCP server or endpoint. Graph /me requires a user; application mode reports that limitation.
      </Text>
      <Text>
        Attach a catalogue ID as <code>project_connection_id</code> in a prompt agent’s native MCP tool definition, deployed through Radius.
        The agent definition owns <code>server_url</code>, <code>server_label</code>, <code>require_approval</code>, headers and <code>allowed_tools</code> — not the catalogue.
        Hosted-agent tools remain in code.
      </Text>
      <Text>
        Skills: supply <code>definition.skills</code> with <code>path</code> and <code>content</code> from Bicep <code>loadTextContent</code>.
        This Adaptive prompt-agent extension captures SKILL.md files with each version; it is not a native Foundry tool wire type.
      </Text>
      {mode ? <Text role="status">Cloud outage injection is enabled; cloud-only tools may fail.</Text> : null}
      {!query.isLoading && !query.error && tools.length === 0 ? (
        <Text className="muted-text">No catalogue tools configured.</Text>
      ) : null}
      <DataGrid items={tools} columns={columns} getRowId={(item) => item.name} className="foundry-grid">
        <DataGridHeader>
          <DataGridRow>
            {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<ToolCatalogEntry>>
          {({ item, rowId }) => (
            <DataGridRow<ToolCatalogEntry> key={rowId}>
              {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>
    </section>
  );
}
