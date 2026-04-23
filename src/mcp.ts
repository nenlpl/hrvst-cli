#!/usr/bin/env node
import _ from "lodash";
import postman from "postman-collection";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig, saveConfig } from "./utils/config";
import { httpRequest } from "./utils/postman-request-command";
import {
  getCurrentLocalISOString,
  getProjectAssignments,
  getRunningTimers,
} from "./utils/timer";
import { request as createRequest } from "./generated-commands/time-entries/create";
import { request as stopRequest } from "./generated-commands/time-entries/stop";
import { request as updateRequest } from "./generated-commands/time-entries/update";
import { request as listRequest } from "./generated-commands/time-entries/list";

const server = new Server(
  { name: "hrvst", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_timer",
      description:
        "Start a running time entry. Provide an alias or explicit project_id and task_id.",
      inputSchema: {
        type: "object",
        properties: {
          alias: {
            type: "string",
            description: "Saved alias name for a project/task pair",
          },
          project_id: { type: "number", description: "Harvest project ID" },
          task_id: { type: "number", description: "Harvest task ID" },
          notes: {
            type: "string",
            description: "Notes to attach to the time entry",
          },
        },
      },
    },
    {
      name: "stop_timer",
      description:
        "Stop a running time entry. If multiple timers are running the response will list them — call again with time_entry_id to target one specifically.",
      inputSchema: {
        type: "object",
        properties: {
          time_entry_id: {
            type: "number",
            description:
              "ID of the specific timer to stop (required when multiple timers are running)",
          },
          notes: {
            type: "string",
            description: "Notes to append to the time entry before stopping",
          },
        },
      },
    },
    {
      name: "log_time",
      description:
        "Create a completed (non-running) time entry for a given number of hours. Provide an alias or explicit project_id and task_id.",
      inputSchema: {
        type: "object",
        required: ["hours"],
        properties: {
          hours: {
            type: "number",
            description: "Number of hours to log (decimals allowed, e.g. 1.5)",
          },
          alias: {
            type: "string",
            description: "Saved alias name for a project/task pair",
          },
          project_id: { type: "number", description: "Harvest project ID" },
          task_id: { type: "number", description: "Harvest task ID" },
          notes: {
            type: "string",
            description: "Notes to attach to the time entry",
          },
          spent_date: {
            type: "string",
            description:
              "ISO 8601 date the time was spent (defaults to today, e.g. 2024-01-15)",
          },
        },
      },
    },
    {
      name: "get_running_timers",
      description: "Return all currently running time entries.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_time_entries",
      description:
        "List time entries, optionally filtered by date range. Returns the most recent page by default.",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Start date filter (ISO 8601, e.g. 2024-01-01)",
          },
          to: {
            type: "string",
            description: "End date filter (ISO 8601, e.g. 2024-01-31)",
          },
          page: {
            type: "number",
            description: "Page number (defaults to 1)",
          },
        },
      },
    },
    {
      name: "list_project_assignments",
      description:
        "List all projects and their tasks that the current user is assigned to, including their IDs. Use this to discover project_id and task_id values before logging time.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_aliases",
      description:
        "List all saved aliases (shorthand names that map to a project/task pair).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_alias",
      description:
        "Save an alias that maps a short name to a project/task pair for faster time logging.",
      inputSchema: {
        type: "object",
        required: ["alias", "project_id", "task_id"],
        properties: {
          alias: { type: "string", description: "Short name for the alias" },
          project_id: { type: "number", description: "Harvest project ID" },
          task_id: { type: "number", description: "Harvest task ID" },
        },
      },
    },
    {
      name: "delete_alias",
      description: "Delete a saved alias by name.",
      inputSchema: {
        type: "object",
        required: ["alias"],
        properties: {
          alias: { type: "string", description: "Name of the alias to delete" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "start_timer":
        return await startTimer(args as StartTimerArgs);
      case "stop_timer":
        return await stopTimer(args as StopTimerArgs);
      case "log_time":
        return await logTime(args as LogTimeArgs);
      case "get_running_timers":
        return await getRunningTimersHandler();
      case "list_time_entries":
        return await listTimeEntries(args as ListTimeEntriesArgs);
      case "list_project_assignments":
        return await listProjectAssignments();
      case "list_aliases":
        return await listAliases();
      case "create_alias":
        return await createAlias(args as CreateAliasArgs);
      case "delete_alias":
        return await deleteAlias(args as DeleteAliasArgs);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ---- types ----------------------------------------------------------------

interface StartTimerArgs {
  alias?: string;
  project_id?: number;
  task_id?: number;
  notes?: string;
}

interface StopTimerArgs {
  time_entry_id?: number;
  notes?: string;
}

interface LogTimeArgs {
  hours: number;
  alias?: string;
  project_id?: number;
  task_id?: number;
  notes?: string;
  spent_date?: string;
}

interface ListTimeEntriesArgs {
  from?: string;
  to?: string;
  page?: number;
}

interface CreateAliasArgs {
  alias: string;
  project_id: number;
  task_id: number;
}

interface DeleteAliasArgs {
  alias: string;
}

// ---- helpers ---------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function resolveProjectTask(
  alias: string | undefined,
  project_id: number | undefined,
  task_id: number | undefined,
): Promise<{ projectId: number; taskId: number }> {
  if (alias) {
    const config = await getConfig();
    const saved = _.get(
      config,
      `accountConfig.${config.accountId}.aliases.${alias}`,
    );
    if (!saved) {
      throw new Error(
        `Alias "${alias}" not found. Use list_aliases to see available aliases or list_project_assignments to find project and task IDs.`,
      );
    }
    return { projectId: saved.projectId, taskId: saved.taskId };
  }

  if (project_id && task_id) {
    return { projectId: project_id, taskId: task_id };
  }

  throw new Error(
    "Provide either an alias or both project_id and task_id. Use list_aliases or list_project_assignments to discover them.",
  );
}

// ---- tool handlers ---------------------------------------------------------

async function startTimer(args: StartTimerArgs) {
  const { projectId, taskId } = await resolveProjectTask(
    args.alias,
    args.project_id,
    args.task_id,
  );

  const url = new postman.Url(createRequest.url);
  const { data } = await httpRequest(createRequest.method, url, {
    project_id: projectId,
    task_id: taskId,
    spent_date: getCurrentLocalISOString(),
    notes: args.notes ?? "",
  });

  return ok(data);
}

async function stopTimer(args: StopTimerArgs) {
  const timers = await getRunningTimers();

  if (!timers.length) {
    return ok({ message: "No running timers found." });
  }

  let timer;

  if (args.time_entry_id) {
    timer = timers.find((t) => t.id === args.time_entry_id);
    if (!timer) {
      throw new Error(
        `Timer ${args.time_entry_id} is not currently running. Running timer IDs: ${timers.map((t) => t.id).join(", ")}`,
      );
    }
  } else if (timers.length > 1) {
    const list = timers.map(
      (t) =>
        `id=${t.id}  ${t.client.name} > ${t.project.name} > ${t.task.name}  (started ${t.timer_started_at})`,
    );
    return ok({
      message:
        "Multiple timers running. Call stop_timer again with a specific time_entry_id.",
      running_timers: list,
    });
  } else {
    timer = timers[0];
  }

  if (args.notes) {
    const updateUrl = new postman.Url(updateRequest.url);
    const existingNotes = timer.notes ?? "";
    const combined = existingNotes
      ? `${existingNotes}\n\n${args.notes}`
      : args.notes;
    await httpRequest(updateRequest.method, updateUrl, {
      time_entry_id: timer.id,
      notes: combined,
    });
  }

  const stopUrl = new postman.Url(stopRequest.url);
  const { data } = await httpRequest(stopRequest.method, stopUrl, {
    time_entry_id: timer.id,
  });

  return ok(data);
}

async function logTime(args: LogTimeArgs) {
  if (isNaN(args.hours) || args.hours <= 0) {
    throw new Error("hours must be a positive number.");
  }

  const { projectId, taskId } = await resolveProjectTask(
    args.alias,
    args.project_id,
    args.task_id,
  );

  const url = new postman.Url(createRequest.url);
  const { data } = await httpRequest(createRequest.method, url, {
    project_id: projectId,
    task_id: taskId,
    hours: args.hours,
    spent_date: args.spent_date ?? getCurrentLocalISOString(),
    notes: args.notes ?? "",
  });

  return ok(data);
}

async function getRunningTimersHandler() {
  const timers = await getRunningTimers();
  return ok(timers.length ? timers : { message: "No running timers." });
}

async function listTimeEntries(args: ListTimeEntriesArgs) {
  const url = new postman.Url(listRequest.url);
  const { data } = await httpRequest(listRequest.method, url, {
    from: args.from,
    to: args.to,
    page: args.page ?? 1,
  });
  return ok(data);
}

async function listProjectAssignments() {
  const assignments = await getProjectAssignments();
  const result = assignments.map((a) => ({
    project_id: a.project.id,
    project_name: a.project.name,
    client_name: a.client.name,
    tasks: a.task_assignments.map((t) => ({
      task_id: t.task.id,
      task_name: t.task.name,
    })),
  }));
  return ok(result);
}

async function listAliases() {
  const config = await getConfig();
  const aliases = _.get(
    config,
    `accountConfig.${config.accountId}.aliases`,
    {},
  ) as Record<string, { projectId: number; taskId: number }>;
  const result = Object.entries(aliases).map(([name, a]) => ({
    alias: name,
    project_id: a.projectId,
    task_id: a.taskId,
  }));
  return ok(result.length ? result : { message: "No aliases saved." });
}

async function createAlias(args: CreateAliasArgs) {
  const config = await getConfig();
  _.setWith(
    config,
    `accountConfig.${config.accountId}.aliases.${args.alias}`,
    { projectId: args.project_id, taskId: args.task_id },
    Object,
  );
  await saveConfig(config);
  return ok({ message: `Alias "${args.alias}" saved.` });
}

async function deleteAlias(args: DeleteAliasArgs) {
  const config = await getConfig();
  const aliases = _.get(config, `accountConfig.${config.accountId}.aliases`);
  if (!aliases || !(args.alias in aliases)) {
    throw new Error(`Alias "${args.alias}" does not exist.`);
  }
  delete aliases[args.alias];
  await saveConfig(config);
  return ok({ message: `Alias "${args.alias}" deleted.` });
}

// ---- bootstrap -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
