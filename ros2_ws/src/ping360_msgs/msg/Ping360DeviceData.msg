# Ping protocol message id 2300 — device_data (manual / single ping)
std_msgs/Header header
uint8 mode
uint8 gain_setting
uint16 angle
uint16 transmit_duration_us
uint16 sample_period_25ns
uint16 transmit_frequency_khz
uint16 number_of_samples
uint16 data_length
uint8[] data
