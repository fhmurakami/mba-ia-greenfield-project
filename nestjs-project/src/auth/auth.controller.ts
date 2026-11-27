import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendConfirmationDto } from './dto/resend-confirmation.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<{ id: string; email: string }> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('confirm-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEmail(@Body() dto: ConfirmEmailDto): Promise<void> {
    await this.authService.confirm(dto.token);
  }

  @Public()
  @Post('resend-confirmation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendConfirmation(@Body() dto: ResendConfirmationDto): Promise<void> {
    await this.authService.resendConfirmation(dto.email);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: LoginDto,
  ): Promise<{ access_token: string; refresh_token: string }> {
    return this.authService.login(dto);
  }
}
