# Generated by Django 3.2.4 on 2021-06-20 20:56

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('apollo', '0006_auto_20180515_2058'),
    ]

    operations = [
        migrations.AddField(
            model_name='player',
            name='path',
            field=models.CharField(default="{'word_list': ['word1']}", max_length=1000),
        ),
    ]
