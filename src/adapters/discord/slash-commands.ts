import { SlashCommandBuilder } from "discord.js";

export function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("onboard")
      .setDescription("新手引导：选择身份并进入引导话题")
      .addStringOption((option) =>
        option
          .setName("role")
          .setDescription("身份")
          .addChoices(
            { name: "admin", value: "admin" },
            { name: "both", value: "both" },
            { name: "adventurer", value: "adventurer" },
            { name: "world creater", value: "world creater" },
          )
          .setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("language")
      .setDescription("设置 bot 回复语言（影响世界/角色文档写入语言）")
      .addStringOption((option) =>
        option
          .setName("lang")
          .setDescription("语言")
          .addChoices({ name: "zh", value: "zh" }, { name: "en", value: "en" })
          .setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("重置对话（创建新的 session）")
      .addIntegerOption((option) =>
        option
          .setName("key")
          .setDescription("会话槽位（默认 0）")
          .setMinValue(0)
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("要重置的用户（默认自己；仅管理员可指定他人）")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("resetall")
      .setDescription("重置全群对话（仅管理员）")
      .addIntegerOption((option) =>
        option
          .setName("key")
          .setDescription("会话槽位（默认 0）")
          .setMinValue(0)
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("切换群模型（仅管理员）")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription(
            "模型 ID（必须在 OPENCODE_MODELS 白名单内；允许包含 `/`；default 清除覆盖）",
          )
          .setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("健康检查")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("查看可用指令")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("world")
      .setDescription("世界系统")
      .addSubcommand((sub) =>
        sub.setName("help").setDescription("查看世界系统指令用法"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription(
            "创建世界（进入编辑话题，多轮补全；/world publish 发布）",
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("open")
          .setDescription("打开该世界的编辑话题（仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("publish")
          .setDescription("发布当前草稿世界（仅创作者，在编辑话题中执行）")
          .addAttachmentOption((option) =>
            option
              .setName("cover")
              .setDescription("可选：world-index 首帖封面图")
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("export")
          .setDescription("导出世界文档（world-card/rules/canon，仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间/编辑话题内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("import")
          .setDescription(
            "上传并覆盖世界文档（world-card/rules/canon，仅创作者）",
          )
          .addStringOption((option) =>
            option
              .setName("kind")
              .setDescription("类型")
              .addChoices(
                { name: "world_card", value: "world_card" },
                { name: "rules", value: "rules" },
                { name: "canon", value: "canon" },
              )
              .setRequired(true),
          )
          .addAttachmentOption((option) =>
            option
              .setName("file")
              .setDescription("要覆盖的 Markdown/TXT 文件")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间/编辑话题内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("image")
          .setDescription("上传世界素材图并写入世界书（仅创作者）")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("图片名称（写入世界书）")
              .setMinLength(1)
              .setMaxLength(80)
              .setRequired(true),
          )
          .addAttachmentOption((option) =>
            option
              .setName("file")
              .setDescription("图片文件（png/jpg/webp/gif/bmp）")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间/编辑话题内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("列出世界（全局）")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 20）")
              .setMinValue(1)
              .setMaxValue(100)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("info")
          .setDescription("查看世界卡")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("rules")
          .setDescription("查看世界规则")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("canon")
          .setDescription("搜索本世界正典（世界卡/规则）")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界入口频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("submit")
          .setDescription(
            "提交提案/任务/正典（写入 world-proposals，待创作者确认）",
          )
          .addStringOption((option) =>
            option
              .setName("kind")
              .setDescription("类型")
              .addChoices(
                { name: "canon", value: "canon" },
                { name: "chronicle", value: "chronicle" },
                { name: "task", value: "task" },
                { name: "news", value: "news" },
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("title")
              .setDescription("标题")
              .setMinLength(1)
              .setMaxLength(80)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("content")
              .setDescription("内容（可简要；复杂内容建议先整理成文本再提交）")
              .setMinLength(1)
              .setMaxLength(2000)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("approve")
          .setDescription("创作者确认并写入正典/任务/编年史")
          .addIntegerOption((option) =>
            option
              .setName("submission_id")
              .setDescription("提交ID")
              .setMinValue(1)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("check")
          .setDescription("检查/搜索世界正典与提案是否包含某关键词")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("加入世界（获得发言权限）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可选；默认使用你的当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("stats")
          .setDescription("查看世界统计")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("查看世界状态（同 stats）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID（在世界子空间频道内可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("搜索世界（按名称/世界卡/规则）")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 10）")
              .setMinValue(1)
              .setMaxValue(50)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("移除世界（管理员）")
          .addIntegerOption((option) =>
            option
              .setName("world_id")
              .setDescription("世界ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("character")
      .setDescription("角色系统")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("创建角色卡（进入编辑话题，多轮补全）")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("角色名（可选；也可在编辑话题中补全）")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("visibility")
              .setDescription("可见性（默认 private）")
              .addChoices(
                { name: "public", value: "public" },
                { name: "private", value: "private" },
              )
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("description")
              .setDescription("补充描述（可选）")
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("help").setDescription("查看角色系统指令用法"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("open")
          .setDescription("打开该角色的编辑话题（仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("export")
          .setDescription("导出角色卡（仅创作者）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（在编辑话题中可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("import")
          .setDescription("上传并覆盖角色卡（仅创作者）")
          .addAttachmentOption((option) =>
            option
              .setName("file")
              .setDescription("要覆盖的 Markdown/TXT 文件")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（在编辑话题中可省略）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("查看角色卡")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("act")
          .setDescription("设置你在本世界的当前角色")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("use")
          .setDescription("设置你的默认角色（全局）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID")
              .setMinValue(1)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("publish")
          .setDescription("将角色设为公开（public 才能被 list/search）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可省略：在编辑话题中会取当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("unpublish")
          .setDescription("将角色设为不公开（private）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("角色ID（可省略：在编辑话题中会取当前角色）")
              .setMinValue(1)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("列出我的角色")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 20）")
              .setMinValue(1)
              .setMaxValue(100)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("搜索公开角色（public）")
          .addStringOption((option) =>
            option
              .setName("query")
              .setDescription("关键词")
              .setMinLength(1)
              .setMaxLength(100)
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("条数（默认 10）")
              .setMinValue(1)
              .setMaxValue(50)
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("adopt")
          .setDescription("使用公开角色：复制或 fork 为你的角色（默认不公开）")
          .addIntegerOption((option) =>
            option
              .setName("character_id")
              .setDescription("公开角色ID")
              .setMinValue(1)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("mode")
              .setDescription("模式")
              .addChoices(
                { name: "copy", value: "copy" },
                { name: "fork", value: "fork" },
              )
              .setRequired(true),
          ),
      )
      .toJSON(),
  ];
}
