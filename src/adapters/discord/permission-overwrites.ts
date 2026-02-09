import { PermissionFlagsBits } from "discord.js";

type PermissionOverwrite = { id: string; allow?: bigint[]; deny?: bigint[] };

export function buildWorldBaseOverwrites(input: {
  everyoneRoleId: string;
  worldRoleId: string;
  creatorUserId: string;
  botUserId: string;
}): {
  info: PermissionOverwrite[];
  join: PermissionOverwrite[];
  roleplay: PermissionOverwrite[];
  forum: PermissionOverwrite[];
  proposals: PermissionOverwrite[];
  voice: PermissionOverwrite[];
} {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const createPrivateThreads = PermissionFlagsBits.CreatePrivateThreads;
  const createPublicThreads = PermissionFlagsBits.CreatePublicThreads;
  const manageThreads = PermissionFlagsBits.ManageThreads;
  const useCommands = PermissionFlagsBits.UseApplicationCommands;
  const connect = PermissionFlagsBits.Connect;
  const speak = PermissionFlagsBits.Speak;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [
          {
            id: input.botUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPrivateThreads,
              createPublicThreads,
              manageThreads,
            ],
          },
        ]
      : [];

  const allowCreatorText =
    input.creatorUserId && input.creatorUserId.trim()
      ? [
          {
            id: input.creatorUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPublicThreads,
              manageThreads,
            ],
          },
        ]
      : [];

  const allowCreatorVoice =
    input.creatorUserId && input.creatorUserId.trim()
      ? [
          {
            id: input.creatorUserId,
            allow: [view, connect, speak],
          },
        ]
      : [];

  const everyoneReadOnly = {
    id: input.everyoneRoleId,
    allow: [view, readHistory, useCommands],
    deny: [send],
  };
  const worldReadOnly = {
    id: input.worldRoleId,
    allow: [view, readHistory, useCommands],
    deny: [send],
  };
  const worldWritable = {
    id: input.worldRoleId,
    allow: [view, readHistory, useCommands, send, sendInThreads],
  };
  const worldForumWritable = {
    id: input.worldRoleId,
    allow: [
      view,
      readHistory,
      useCommands,
      send,
      sendInThreads,
      createPublicThreads,
    ],
  };

  return {
    info: [everyoneReadOnly, worldReadOnly, ...allowCreatorText, ...allowBot],
    join: [everyoneReadOnly, worldWritable, ...allowCreatorText, ...allowBot],
    roleplay: [
      everyoneReadOnly,
      worldWritable,
      ...allowCreatorText,
      ...allowBot,
    ],
    forum: [
      everyoneReadOnly,
      worldForumWritable,
      ...allowCreatorText,
      ...allowBot,
    ],
    proposals: [
      everyoneReadOnly,
      worldWritable,
      ...allowCreatorText,
      ...allowBot,
    ],
    voice: [
      { id: input.everyoneRoleId, allow: [view], deny: [connect, speak] },
      { id: input.worldRoleId, allow: [view, connect, speak] },
      ...allowCreatorVoice,
    ],
  };
}

export function buildWorldShowcaseOverwrites(input: {
  everyoneRoleId: string;
  botUserId: string;
}): PermissionOverwrite[] {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const useCommands = PermissionFlagsBits.UseApplicationCommands;
  const createPublicThreads = PermissionFlagsBits.CreatePublicThreads;
  const manageThreads = PermissionFlagsBits.ManageThreads;

  return [
    {
      id: input.everyoneRoleId,
      allow: [view, readHistory, sendInThreads, useCommands],
      deny: [send],
    },
    {
      id: input.botUserId,
      allow: [
        view,
        readHistory,
        send,
        sendInThreads,
        createPublicThreads,
        manageThreads,
      ],
    },
  ];
}

export function buildDraftCreatorOnlyOverwrites(input: {
  everyoneRoleId: string;
  creatorUserId: string;
  botUserId: string;
}): PermissionOverwrite[] {
  const view = PermissionFlagsBits.ViewChannel;
  const readHistory = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const sendInThreads = PermissionFlagsBits.SendMessagesInThreads;
  const createPrivateThreads = PermissionFlagsBits.CreatePrivateThreads;
  const manageThreads = PermissionFlagsBits.ManageThreads;

  const allowBot =
    input.botUserId && input.botUserId.trim()
      ? [
          {
            id: input.botUserId,
            allow: [
              view,
              readHistory,
              send,
              sendInThreads,
              createPrivateThreads,
              manageThreads,
            ],
          },
        ]
      : [];

  return [
    { id: input.everyoneRoleId, deny: [view] },
    {
      id: input.creatorUserId,
      allow: [view, readHistory, send, sendInThreads],
    },
    ...allowBot,
  ];
}
