import chalk from 'chalk';

export interface ProgressStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
}

export interface TaskProgress {
  taskId: string;
  title: string;
  steps: ProgressStep[];
  currentStepIndex: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

export class ProgressTracker {
  private tasks: Map<string, TaskProgress> = new Map();
  private currentTask?: string;
  private listeners: ((progress: TaskProgress) => void)[] = [];

  createTask(title: string, steps: string[]): TaskProgress {
    const task: TaskProgress = {
      taskId: `task_${Date.now()}`,
      title,
      steps: steps.map((name, index) => ({
        id: `step_${index}`,
        name,
        status: 'pending',
      })),
      currentStepIndex: -1,
      status: 'pending',
      createdAt: Date.now(),
    };
    
    this.tasks.set(task.taskId, task);
    this.currentTask = task.taskId;
    return task;
  }

  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'running';
      this.notifyListeners(task);
    }
  }

  startStep(stepId: string): void {
    if (!this.currentTask) return;
    
    const task = this.tasks.get(this.currentTask);
    if (!task) return;

    const step = task.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'running';
      step.startTime = Date.now();
      const stepIndex = task.steps.findIndex(s => s.id === stepId);
      task.currentStepIndex = stepIndex;
      this.notifyListeners(task);
      this.printProgress(task);
    }
  }

  completeStep(stepId: string, result?: string): void {
    if (!this.currentTask) return;
    
    const task = this.tasks.get(this.currentTask);
    if (!task) return;

    const step = task.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.endTime = Date.now();
      step.result = result;
      this.notifyListeners(task);
      this.printProgress(task);
    }
  }

  failStep(stepId: string, error: string): void {
    if (!this.currentTask) return;
    
    const task = this.tasks.get(this.currentTask);
    if (!task) return;

    const step = task.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.endTime = Date.now();
      step.error = error;
      task.status = 'failed';
      this.notifyListeners(task);
      this.printProgress(task);
    }
  }

  completeTask(result?: string): void {
    if (!this.currentTask) return;
    
    const task = this.tasks.get(this.currentTask);
    if (!task) return;

    task.status = 'completed';
    task.completedAt = Date.now();
    
    const pendingSteps = task.steps.filter(s => s.status === 'pending');
    pendingSteps.forEach(step => {
      step.status = 'completed';
      step.result = '(跳过)';
    });
    
    this.notifyListeners(task);
    this.printProgress(task);
    console.log(chalk.green('\n✅ 任务完成！\n'));
  }

  getCurrentTask(): TaskProgress | undefined {
    if (!this.currentTask) return undefined;
    return this.tasks.get(this.currentTask);
  }

  getTask(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): TaskProgress[] {
    return Array.from(this.tasks.values());
  }

  calculateProgress(task: TaskProgress): number {
    if (task.steps.length === 0) return 0;
    const completed = task.steps.filter(s => s.status === 'completed').length;
    return Math.round((completed / task.steps.length) * 100);
  }

  getStepDuration(step: ProgressStep): string {
    if (!step.startTime) return '';
    const end = step.endTime || Date.now();
    const duration = Math.round((end - step.startTime) / 1000);
    if (duration < 60) return `${duration}s`;
    return `${Math.floor(duration / 60)}m ${duration % 60}s`;
  }

  printProgress(task: TaskProgress): void {
    const progress = this.calculateProgress(task);
    const barWidth = 30;
    const filledWidth = Math.round((progress / 100) * barWidth);
    const bar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth);
    
    console.clear();
    
    console.log(chalk.bold(`\n📋 ${task.title}\n`));
    console.log(`  ${chalk.cyan('进度:')} [${chalk.cyan(bar)}] ${chalk.bold(progress + '%')}\n`);
    
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i];
      if (!step) continue;
      
      const icon = this.getStepIcon(step.status);
      const duration = step.startTime ? this.getStepDuration(step) : '';
      
      if (step.status === 'running') {
        console.log(chalk.cyan(`  ${icon} ${step.name}`) + chalk.gray(' 运行中...'));
      } else if (step.status === 'completed') {
        console.log(chalk.green(`  ${icon} ${step.name}`) + chalk.gray(duration ? ` (${duration})` : ''));
      } else if (step.status === 'failed') {
        console.log(chalk.red(`  ${icon} ${step.name}`) + chalk.gray(' 失败'));
        if (step.error) {
          console.log(chalk.red(`     └─ ${step.error}`));
        }
      } else {
        console.log(chalk.gray(`  ${icon} ${step.name}`));
      }
    }
    
    console.log();
  }

  private getStepIcon(status: ProgressStep['status']): string {
    switch (status) {
      case 'completed': return '✓';
      case 'running': return '⟳';
      case 'failed': return '✗';
      default: return '○';
    }
  }

  onProgressUpdate(callback: (progress: TaskProgress) => void): void {
    this.listeners.push(callback);
  }

  private notifyListeners(task: TaskProgress): void {
    for (const listener of this.listeners) {
      listener(task);
    }
  }

  clear(): void {
    this.tasks.clear();
    this.currentTask = undefined;
  }
}

export const progressTracker = new ProgressTracker();

export class LiveProgressDisplay {
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private currentMessage = '';
  private intervalId?: NodeJS.Timeout;

  start(message: string): void {
    this.currentMessage = message;
    this.spinnerIndex = 0;
    
    process.stdout.write(chalk.cyan(`\r${this.spinnerFrames[0]} ${message}`));
    
    this.intervalId = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      process.stdout.write(chalk.cyan(`\r${this.spinnerFrames[this.spinnerIndex]} ${this.currentMessage}`));
    }, 100);
  }

  update(message: string): void {
    this.currentMessage = message;
    process.stdout.write(chalk.cyan(`\r${this.spinnerFrames[this.spinnerIndex]} ${message}`));
  }

  stop(success = true): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
    
    if (success) {
      console.log(chalk.green('✓ ') + this.currentMessage);
    } else {
      console.log(chalk.red('✗ ') + this.currentMessage);
    }
  }
}

export const liveProgressDisplay = new LiveProgressDisplay();
