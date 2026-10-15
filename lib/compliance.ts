// ─── 合规规则引擎（确定性正则，与 LLM 扫描互补） ──────────────────
import { ComplianceFinding } from './types';

interface Rule {
  name: string;
  basis: string;
  note: string;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    name: '收益承诺/保本表述',
    basis: '《证券法》第161条：不得对证券收益作出承诺或保本保收益',
    note: '存在收益承诺或保本类表述，投研内容严禁出现',
    patterns: [
      /稳赚(不赔)?/, /保本/, /包赚/, /必涨/, /必赚/, /翻倍/, /旱涝保收/,
      /无风险(收益|回报)/, /保证.{0,4}收益/, /收益.{0,4}保证/, /百发百中/,
    ],
  },
  {
    name: '确定性买卖建议',
    basis: '《发布证券研究报告暂行规定》第12条：不得作出确定性买卖建议',
    note: '出现建议/指令式买卖表述或目标价，需具备投顾资质且充分提示风险',
    patterns: [
      /(建议|推荐|值得|可以).{0,6}(买入|卖出|增持|减持|建仓|清仓|加仓|减仓|抄底|杀入)/,
      /(买入|卖出|增持|减持)评级/, /目标价\s*[：:]?\s*\d/, /抄底/, /清仓/, /满仓干/, /all\s*in/i,
      /(赶紧|立即|马上|速来).{0,4}(买|卖|上车|下车)/,
    ],
  },
  {
    name: '夸大误导表述',
    basis: '《证券期货投资者适当性管理办法》：不得夸大宣传、误导投资者',
    note: '情绪化夸大表述，涉嫌误导投资者',
    patterns: [
      /躺赢/, /闭眼(买|入)/, /财富密码/, /内部消息/, /内幕/, /错过再等/,
      /(最后一班|末班车).{0,4}(车)?/, /逢买必涨/, /只赚不亏/, /稳稳.{0,4}(赚|幸福)/,
    ],
  },
  {
    name: '无依据确定性预测',
    basis: '《证券分析师执业行为准则》：预测须有合理依据并提示不确定性',
    note: '确定性预测表述，需核实是否有数据依据并充分提示风险',
    patterns: [
      /必将.{0,8}(涨|跌|翻|突破)/, /百分之百/, /肯定(会|能).{0,6}(涨|跌)/,
      /(必然|注定).{0,8}(涨|跌|暴涨|暴跌)/, /涨停板(敢死队)?已就位/,
    ],
  },
];

export function scanCompliance(text: string): ComplianceFinding[] {
  const sentences = text
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const findings: ComplianceFinding[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    for (const sentence of sentences) {
      for (const p of rule.patterns) {
        if (p.test(sentence)) {
          const key = rule.name + '|' + sentence.slice(0, 80);
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              quote: sentence.slice(0, 200),
              rule: rule.name,
              basis: rule.basis,
              note: rule.note,
              origin: 'rule',
              reviewed: null,
              review_note: null,
            });
          }
          break;
        }
      }
    }
  }
  return findings;
}
