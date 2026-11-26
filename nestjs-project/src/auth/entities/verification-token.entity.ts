import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export const VerificationTokenType = {
  EMAIL_CONFIRMATION: 'email_confirmation',
  PASSWORD_RESET: 'password_reset',
} as const;

export type VerificationTokenType =
  (typeof VerificationTokenType)[keyof typeof VerificationTokenType];

@Entity('verification_tokens')
@Index(['token_hash'])
@Index(['user_id', 'type'])
export class VerificationToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  token_hash: string;

  @Column({
    type: 'enum',
    enum: ['email_confirmation', 'password_reset'],
  })
  type: VerificationTokenType;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'timestamp' })
  expires_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  used_at: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
