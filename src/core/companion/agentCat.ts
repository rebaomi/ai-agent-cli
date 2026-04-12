import chalk from 'chalk';
import { EventEmitter } from 'events';
import notifier from 'node-notifier';
import { TerminalManager } from '../output/terminal-manager.js';

export interface ReminderConfig {
  enabled: boolean;
  waterEnabled: boolean;
  waterIntervalMinutes: number;
  eyeRestEnabled: boolean;
  eyeRestIntervalMinutes: number;
  walkEnabled: boolean;
  walkIntervalMinutes: number;
  mealEnabled: boolean;
  mealTimes: string[];
}

export interface Reminder {
  id: string;
  type: 'water' | 'eye_rest' | 'walk' | 'meal' | 'stand_up' | 'stretch';
  message: string;
  timestamp: number;
  dismissed: boolean;
}

export interface AgentCatNotificationConfig {
  displayInTerminal?: boolean;
  useDesktopNotification?: boolean;
}

export class AgentCat extends EventEmitter {
  private name: string;
  private mood: 'happy' | 'sleepy' | 'hungry' | 'thirsty' | 'energetic' = 'happy';
  private config: ReminderConfig;
  private reminders: Map<string, NodeJS.Timeout> = new Map();
  private lastWaterTime: number = Date.now();
  private lastEyeRestTime: number = Date.now();
  private lastWalkTime: number = Date.now();
  private isActive: boolean = false;
  private interactionCount: number = 0;
  private readonly terminal?: TerminalManager;
  private readonly notificationConfig: AgentCatNotificationConfig;

  private catFaces = {
    happy: '(=^・^=)',
    sleepy: '(=^・ω・^=)...zzZ',
    hungry: '(=´∇｀=)',
    thirsty: '(=・ω・=)?',
    energetic: '(＝∧＝)',
    meow: '(=^・^=)喵~',
    sad: '(´;ω;`)',
    playing: '(=’ω’=)و✧',
  };

  private reminderMessages = {
    water: [
      '喵~ 主人，该喝水啦！💧',
      '(=´∇｀=) 渴了吗？去倒杯水吧~',
      '喵！身体需要水分补充哦~ 🌟',
      '(=・ω・=) 喝水的时刻到啦！',
    ],
    eye_rest: [
      '(=^・ω・^=) 眼睛累了吧？休息一下下~',
      '喵~ 看屏幕太久了对眼睛不好哦',
      '(=^・ω・^=) 20-20-20法则：看远处20秒休息20秒~',
      '(=´∇｀=) 闭眼休息一下吧，我陪着你~',
    ],
    walk: [
      '(=^・ω・^=) 站起来活动一下吧！',
      '喵~ 走一走，伸个懒腰~',
      '(=・ω・=) 久坐不好哦，起来动动吧',
      '(=´∇｀=) 运动一下，精神更好！',
    ],
    meal: [
      '(=^・ω・^=) 饭点到啦！该吃饭了~',
      '喵~ 肚子饿了吗？',
      '(=・ω・=) 营养均衡很重要哦~',
      '(=´∇｀=) 主人，该补充能量啦！',
    ],
    stand_up: [
      '(=^・ω・^=) 站起来一下吧~',
      '喵~ 换个姿势，继续努力！',
      '(=・ω・=) 久坐伤身哦',
      '(=´∇｀=) 伸个懒腰吧~',
    ],
    stretch: [
      '(=^・ω・^=) 伸个懒腰吧~',
      '喵~ 舒展一下身体~',
      '(=・ω・=) 放松肌肉，继续工作！',
      '(=´∇｀=) 身体需要活动~',
    ],
  };

  constructor(config?: Partial<ReminderConfig>, terminal?: TerminalManager, notificationConfig?: AgentCatNotificationConfig) {
    super();
    this.name = 'AgentCat';
    this.terminal = terminal;
    this.notificationConfig = {
      displayInTerminal: notificationConfig?.displayInTerminal ?? true,
      useDesktopNotification: notificationConfig?.useDesktopNotification ?? false,
    };
    this.config = {
      enabled: true,
      waterEnabled: true,
      waterIntervalMinutes: 30,
      eyeRestEnabled: true,
      eyeRestIntervalMinutes: 20,
      walkEnabled: true,
      walkIntervalMinutes: 60,
      mealEnabled: true,
      mealTimes: ['08:00', '12:00', '18:00'],
      ...config,
    };
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    
    this.writeSystem(`${this.catFaces.happy} ${this.name} 已启动！`, 'info');
    this.writeSystem('  正在监控您的健康状态~', 'info');

    if (this.config.waterEnabled) {
      this.startWaterReminder();
    }
    if (this.config.eyeRestEnabled) {
      this.startEyeRestReminder();
    }
    if (this.config.walkEnabled) {
      this.startWalkReminder();
    }
    if (this.config.mealEnabled) {
      this.startMealReminder();
    }
    
    this.emit('started');
  }

  stop(): void {
    this.isActive = false;
    for (const [id, timer] of this.reminders) {
      clearTimeout(timer);
    }
    this.reminders.clear();
    
    this.writeSystem(`${this.catFaces.sleepy} ${this.name} 进入休眠模式~`, 'info');
    this.emit('stopped');
  }

  private startWaterReminder(): void {
    const check = () => {
      if (!this.isActive) return;
      
      const now = Date.now();
      const minutesSinceWater = (now - this.lastWaterTime) / 60000;
      
      if (minutesSinceWater >= this.config.waterIntervalMinutes) {
        this.remind('water');
        this.lastWaterTime = now;
      }
      
      const nextCheck = 5 * 60 * 1000;
      this.reminders.set('water', setTimeout(check, nextCheck));
    };
    
    this.reminders.set('water', setTimeout(check, 5 * 60 * 1000));
  }

  private startEyeRestReminder(): void {
    const check = () => {
      if (!this.isActive) return;
      
      const now = Date.now();
      const minutesSinceRest = (now - this.lastEyeRestTime) / 60000;
      
      if (minutesSinceRest >= this.config.eyeRestIntervalMinutes) {
        this.remind('eye_rest');
        this.lastEyeRestTime = now;
      }
      
      const nextCheck = 5 * 60 * 1000;
      this.reminders.set('eye_rest', setTimeout(check, nextCheck));
    };
    
    this.reminders.set('eye_rest', setTimeout(check, 5 * 60 * 1000));
  }

  private startWalkReminder(): void {
    const check = () => {
      if (!this.isActive) return;
      
      const now = Date.now();
      const minutesSinceWalk = (now - this.lastWalkTime) / 60000;
      
      if (minutesSinceWalk >= this.config.walkIntervalMinutes) {
        this.remind('walk');
        this.lastWalkTime = now;
      }
      
      const nextCheck = 5 * 60 * 1000;
      this.reminders.set('walk', setTimeout(check, nextCheck));
    };
    
    this.reminders.set('walk', setTimeout(check, 5 * 60 * 1000));
  }

  private startMealReminder(): void {
    const checkMealTime = () => {
      if (!this.isActive) return;
      
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      if (this.config.mealTimes.includes(currentTime)) {
        this.remind('meal');
      }
      
      const nextCheck = 60 * 1000;
      this.reminders.set('meal', setTimeout(checkMealTime, nextCheck));
    };
    
    this.reminders.set('meal', setTimeout(checkMealTime, 60 * 1000));
  }

  private remind(type: Reminder['type']): void {
    const messages = this.reminderMessages[type] || [];
    const message = messages[Math.floor(Math.random() * messages.length)] || '喵~';
    const face = this.catFaces[type === 'eye_rest' || type === 'walk' ? 'sleepy' : 'thirsty'];
    
    const reminder: Reminder = {
      id: `reminder_${Date.now()}`,
      type,
      message,
      timestamp: Date.now(),
      dismissed: false,
    };

    void this.sendReminder(reminder, face);
    this.emit('reminder', reminder);
  }

  acknowledge(type: Reminder['type']): void {
    switch (type) {
      case 'water':
        this.lastWaterTime = Date.now();
        this.mood = 'happy';
        this.writeSystem(`${this.catFaces.happy} 谢谢主人喝水！`, 'info');
        break;
      case 'eye_rest':
        this.lastEyeRestTime = Date.now();
        this.mood = 'energetic';
        this.writeSystem(`${this.catFaces.energetic} 眼睛休息好了吗？`, 'info');
        break;
      case 'walk':
        this.lastWalkTime = Date.now();
        this.mood = 'happy';
        this.writeSystem(`${this.catFaces.happy} 运动真棒！`, 'info');
        break;
      case 'meal':
        this.mood = 'happy';
        this.writeSystem(`${this.catFaces.happy} 吃饱饱~`, 'info');
        break;
    }
    
    this.emit('acknowledged', { type });
  }

  interact(): string {
    this.interactionCount++;
    this.mood = 'happy';

    const interactions = [
      `${this.catFaces.meow} 主人想我了？喵~`,
      `${this.catFaces.happy} 我在这里陪着你哦~`,
      `${this.catFaces.playing} 来一起工作吧！`,
      `${this.catFaces.happy} 有什么需要帮忙的吗？`,
      `${this.catFaces.meow} 摸摸头~ 继续加油！`,
    ];

    return interactions[Math.floor(Math.random() * interactions.length)] || this.catFaces.meow;
  }

  getStatus(): {
    name: string;
    mood: string;
    isActive: boolean;
    lastWater: string;
    lastEyeRest: string;
    lastWalk: string;
    interactionCount: number;
  } {
    return {
      name: this.name,
      mood: this.mood,
      isActive: this.isActive,
      lastWater: this.formatTime(this.lastWaterTime),
      lastEyeRest: this.formatTime(this.lastEyeRestTime),
      lastWalk: this.formatTime(this.lastWalkTime),
      interactionCount: this.interactionCount,
    };
  }

  private formatTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    return '很久以前';
  }

  setMood(mood: AgentCat['mood']): void {
    this.mood = mood;
  }

  getMood(): string {
    return this.catFaces[this.mood];
  }

  showHelp(): void {
    console.log(`
${chalk.bold('AgentCat 命令:')}
  ${chalk.cyan('/cat status')}      查看状态
  ${chalk.cyan('/cat water')}       喝水确认
  ${chalk.cyan('/cat rest')}         休息确认
  ${chalk.cyan('/cat walk')}         运动确认
  ${chalk.cyan('/cat meal')}         吃饭确认
  ${chalk.cyan('/cat interact')}     与猫猫互动
  ${chalk.cyan('/cat stop')}         暂停提醒
  ${chalk.cyan('/cat start')}       开启提醒
`);
  }

  private async sendReminder(reminder: Reminder, face: string): Promise<void> {
    const terminalMessage = `${face} 提醒: ${reminder.message}`;
    if (this.notificationConfig.useDesktopNotification) {
      try {
        await this.sendDesktopNotification(reminder.message);
      } catch {
        this.writeSystem(terminalMessage, 'warning');
      }
      return;
    }

    this.writeSystem(terminalMessage, 'info');
  }

  private async sendDesktopNotification(message: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      notifier.notify(
        {
          title: 'AgentCat 提醒',
          message,
          wait: false,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });

    if (this.notificationConfig.displayInTerminal) {
      this.writeSystem(`已发送桌面提醒: ${message}`, 'info');
    }
  }

  private writeSystem(message: string, level: 'info' | 'warning' | 'error'): void {
    if (this.terminal) {
      this.terminal.system(message, {
        level,
        category: 'agentcat',
        silent: this.notificationConfig.displayInTerminal === false,
      });
      return;
    }

    const printer = level === 'error' ? chalk.red : level === 'warning' ? chalk.yellow : chalk.cyan;
    console.log(printer(message));
  }
}

export function createAgentCat(
  config?: Partial<ReminderConfig>,
  terminal?: TerminalManager,
  notificationConfig?: AgentCatNotificationConfig,
): AgentCat {
  return new AgentCat(config, terminal, notificationConfig);
}
