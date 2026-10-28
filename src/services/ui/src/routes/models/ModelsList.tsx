import {
  Badge,
  Button,
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
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Model, listModels } from '../../api/client';

function formatDate(created?: number | null): string {
  if (!created) {
    return '—';
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(created * 1000),
  );
}

function providerBadge(model: Model): JSX.Element {
  if (model.kind === 'set') {
    return (
      <Badge appearance="tint" color="severe">
        multi-model
      </Badge>
    );
  }
  if (model.provider === 'foundry') {
    return (
      <Badge appearance="tint" color="brand">
        foundry
      </Badge>
    );
  }
  if (model.provider === 'huggingface') {
    return (
      <Badge appearance="tint" color="success">
        local
      </Badge>
    );
  }
  return (
    <Badge appearance="tint" color="informative">
      gateway
    </Badge>
  );
}

function statusBadge(model: Model): JSX.Element {
  const status = model.status ?? 'Unknown';
  if (status === 'Provisioning') {
    return (
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        title="The gateway reports provisioning; the model is not ready for invocation."
      >
        <Spinner size="tiny" />
        <Badge appearance="filled" color="warning">
          Provisioning
        </Badge>
      </span>
    );
  }
  const color = status === 'Ready' ? 'success' : 'subtle';
  return (
    <Badge appearance="filled" color={color}>
      {status}
    </Badge>
  );
}

export function ModelsList(): JSX.Element {
  const navigate = useNavigate();
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: listModels,
    // Poll while any model is still provisioning so the status/indicator goes
    // live (Provisioning → Ready) without a manual page refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((m) => m.status === 'Provisioning') ? 5000 : false,
  });
  const rows = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  const columns: TableColumnDefinition<Model>[] = useMemo(
    () => [
      createTableColumn<Model>({
        columnId: 'name',
        renderHeaderCell: () => 'Name',
        renderCell: (model) => (
          <div className="model-name-cell">
            <Text weight="semibold">{model.id}</Text>
            {model.kind === 'set' && model.members ? (
              <Text size={200} className="muted-text">
                {model.members
                  .slice()
                  .sort((a, b) => a.priority - b.priority)
                  .map((m) => m.model)
                  .join(' → ')}
              </Text>
            ) : null}
          </div>
        ),
      }),
      createTableColumn<Model>({
        columnId: 'provider',
        renderHeaderCell: () => 'Type',
        renderCell: (model) => providerBadge(model),
      }),
      createTableColumn<Model>({
        columnId: 'status',
        renderHeaderCell: () => 'Status',
        renderCell: (model) => statusBadge(model),
      }),
      createTableColumn<Model>({
        columnId: 'created',
        renderHeaderCell: () => 'Created',
        renderCell: (model) => formatDate(model.created),
      }),
      createTableColumn<Model>({
        columnId: 'actions',
        renderHeaderCell: () => 'Actions',
        renderCell: (model) => (
          <>
            <Button
              appearance="secondary"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                navigate(`/models/${encodeURIComponent(model.id)}/playground`);
              }}
            >
              Playground
            </Button>
          </>
        ),
      }),
    ],
    [navigate],
  );

  return (
    <section className="page models-list-page">
      <div className="page-heading">
        <div className="page-heading-text">
          <Text as="h1" size={600} weight="semibold">
            Models
          </Text>
          <Text className="muted-text">View gateway models and open their playgrounds. Management is read-only.</Text>
        </div>
      </div>

      {modelsQuery.isLoading ? <Spinner label="Loading models" /> : null}
      {modelsQuery.error ? <div className="error-text" role="alert">Failed to load models. {modelsQuery.error.message}</div> : null}

      {!modelsQuery.isLoading && !modelsQuery.error && rows.length === 0 ? (
        <div className="empty-state">
          <Text className="muted-text">
            No models are configured in the gateway.
          </Text>
        </div>
      ) : (
        <>
          <DataGrid
            items={rows}
            columns={columns}
            getRowId={(item) => item.id}
            columnSizingOptions={{
              actions: { defaultWidth: 150, idealWidth: 150, minWidth: 120 },
            }}
            className="foundry-grid"
          >
            <DataGridHeader>
              <DataGridRow>
                {({ renderHeaderCell }) => (
                  <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                )}
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody<Model>>
              {({ item, rowId }) => (
                <DataGridRow<Model> key={rowId}>
                  {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                </DataGridRow>
              )}
            </DataGridBody>
          </DataGrid>
          <Text className="muted-text">
            {rows.length} model{rows.length === 1 ? '' : 's'}
          </Text>
        </>
      )}

    </section>
  );
}
