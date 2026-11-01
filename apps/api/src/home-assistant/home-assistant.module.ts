import { Global, Module } from '@nestjs/common';
import { EnergyService } from './energy.service';
import { HaApiService } from './ha-api.service';
import { HomeAssistantController } from './home-assistant.controller';

@Global()
@Module({
    controllers: [HomeAssistantController],
    providers: [HaApiService, EnergyService],
    exports: [HaApiService, EnergyService],
})
export class HomeAssistantModule {}
