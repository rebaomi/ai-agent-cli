import chalk from 'chalk';
import { EventEmitter } from 'events';

export interface ReminderConfig {
  enabled: boolean;
  waterIntervalMinutes: number;
  eyeRestIntervalMinutes: number;
  walkIntervalMinutes: number;
  mealTimes: string[];
}

export interface Reminder {
  id: string;
  type: 'water' | 'eye_rest' | 'walk' | 'meal' | 'stand_up' | 'stretch';
  message: string;
  timestamp: number;
  dismissed: boolean;
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

  constructor(config?: Partial<ReminderConfig>) {
    super();
    this.name = 'AgentCat';
    this.config = {
      enabled: true,
      waterIntervalMinutes: 30,
      eyeRestIntervalMinutes: 20,
      walkIntervalMinutes: 60,
      mealTimes: ['08:00', '12:00', '18:00'],
      ...config,
    };
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    
    console.log(chalk.cyan(`${this.catFaces.happy} ${this.name} 已启动！`));
    console.log(chalk.gray('  正在监控您的健康状态~\n'));

    this.startWaterReminder();
    this.startEyeRestReminder();
    this.startWalkReminder();
    this.startMealReminder();
    
    this.emit('started');
  }

  stop(): void {
    this.isActive = false;
    for (const [id, timer] of this.reminders) {
      clearTimeout(timer);
    }
    this.reminders.clear();
    
    console.log(chalk.gray(`${this.catFaces.sleepy} ${this.name} 进入休眠模式~\n`));
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

    console.log(chalk.cyan(`\n${face} 提醒: ${message}\n`));
    this.emit('reminder', reminder);
  }

  acknowledge(type: Reminder['type']): void {
    switch (type) {
      case 'water':
        this.lastWaterTime = Date.now();
        this.mood = 'happy';
        console.log(chalk.green(`${this.catFaces.happy} 谢谢主人喝水！`));
        break;
      case 'eye_rest':
        this.lastEyeRestTime = Date.now();
        this.mood = 'energetic';
        console.log(chalk.green(`${this.catFaces.energetic} 眼睛休息好了吗？`));
        break;
      case 'walk':
        this.lastWalkTime = Date.now();
        this.mood = 'happy';
        console.log(chalk.green(`${this.catFaces.happy} 运动真棒！`));
        break;
      case 'meal':
        this.mood = 'happy';
        console.log(chalk.green(`${this.catFaces.happy} 吃饱饱~`));
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
}

export function createAgentCat(config?: Partial<ReminderConfig>): AgentCat {
  return new AgentCat(config);
}
