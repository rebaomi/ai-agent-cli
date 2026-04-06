export type PatternCategory = 'creational' | 'structural' | 'behavioral';

export interface PatternMetadata {
  name: string;
  category: PatternCategory;
  description: string;
  useCase: string;
}

export const PATTERNS: PatternMetadata[] = [
  { name: 'Singleton', category: 'creational', description: '单例模式，确保只有一个实例', useCase: '配置管理、全局状态' },
  { name: 'Factory', category: 'creational', description: '工厂模式，创建对象不指定具体类', useCase: 'Agent 创建、日志工厂' },
  { name: 'AbstractFactory', category: 'creational', description: '抽象工厂，生成相关对象族', useCase: '跨平台 Agent' },
  { name: 'Builder', category: 'creational', description: '建造者模式，分步构建复杂对象', useCase: '复杂配置构建' },
  { name: 'Prototype', category: 'creational', description: '原型模式，通过克隆创建对象', useCase: 'Agent 模板复制' },
  
  { name: 'Adapter', category: 'structural', description: '适配器模式，接口转换', useCase: 'MCP 协议适配' },
  { name: 'Bridge', category: 'structural', description: '桥接模式，分离抽象与实现', useCase: '工具与执行分离' },
  { name: 'Composite', category: 'structural', description: '组合模式，树形结构管理', useCase: '组织架构树' },
  { name: 'Decorator', category: 'structural', description: '装饰器模式，动态添加功能', useCase: '工具增强' },
  { name: 'Facade', category: 'structural', description: '外观模式，统一接口', useCase: 'Agent 对外接口' },
  { name: 'Flyweight', category: 'structural', description: '享元模式，共享细粒度对象', useCase: '工具实例复用' },
  { name: 'Proxy', category: 'structural', description: '代理模式，控制访问', useCase: '权限控制、日志代理' },
  
  { name: 'ChainOfResponsibility', category: 'behavioral', description: '责任链模式，请求传递', useCase: '任务处理链' },
  { name: 'Command', category: 'behavioral', description: '命令模式，请求封装', useCase: '操作撤销/重做' },
  { name: 'Interpreter', category: 'behavioral', description: '解释器模式，语法解析', useCase: '自然语言理解' },
  { name: 'Iterator', category: 'behavioral', description: '迭代器模式，遍历集合', useCase: '消息遍历' },
  { name: 'Mediator', category: 'behavioral', description: '中介者模式，对象协调', useCase: 'Agent 间通信' },
  { name: 'Memento', category: 'behavioral', description: '备忘录模式，状态保存', useCase: '记忆管理' },
  { name: 'Observer', category: 'behavioral', description: '观察者模式，事件通知', useCase: '任务状态更新' },
  { name: 'State', category: 'behavioral', description: '状态模式，状态切换行为', useCase: 'Agent 状态管理' },
  { name: 'Strategy', category: 'behavioral', description: '策略模式，算法替换', useCase: '不同执行策略' },
  { name: 'TemplateMethod', category: 'behavioral', description: '模板方法模式，算法骨架', useCase: '任务处理流程' },
  { name: 'Visitor', category: 'behavioral', description: '访问者模式，数据与操作分离', useCase: 'Agent 操作扩展' },
];

export function getPatternByName(name: string): PatternMetadata | undefined {
  return PATTERNS.find(p => p.name.toLowerCase() === name.toLowerCase());
}

export function getPatternsByCategory(category: PatternCategory): PatternMetadata[] {
  return PATTERNS.filter(p => p.category === category);
}
